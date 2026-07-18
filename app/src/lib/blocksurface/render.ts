// Block model -> DOM (SKR-95, Stage 3a). The read half of the bespoke surface:
// turn a Document into cheap per-block DOM under one contenteditable host (the
// Stage 2 winner). The write half (selection mapping + the keystroke hot path)
// lives in selection.ts / surface.ts and patches this DOM in place.
//
// Virtualization is deferred (the gate holds at 10k without it — see
// harness/stage2-keystroke-spike-finding.md), but the design stays
// virtualization-AWARE: every block carries a data-block-id and is reached
// through a registry that already tolerates an absent element, so windowing later
// is a feature add, not a rewrite of selection/commands.

import type { BlockNode, InlineMarks, InlineNode } from '../blockmodel';
import { isSafeUrl } from '../security/urls';
import { languageLabel } from './highlight/languages';

export const BLOCK_ID_ATTR = 'data-block-id';
// Marks a rendered hard-break atom so the offset mapping can tell it apart from
// the bare <br> an empty block needs for height/caret (which has zero width in
// the model). Only real breaks carry a cell in the offset space (SKR-155).
export const HARD_BREAK_ATTR = 'data-hard-break';
// Zero-width caret filler (U+200B) placed on the empty new line a TRAILING hard
// break opens (SKR-176). WKWebView commits but mis-PAINTS a caret anchored at the
// bare element position between the hard-break <br> and a placeholder <br> — it
// snaps to the block start. A text node is the only anchor WebKit paints reliably,
// so the filler gives the caret a real text position to sit in. It is zero-width to
// the offset map and stripped on readback, so the model never sees it.
export const CARET_FILLER = '\u200b';
// An inline tag leaf renders as a `<span class="sk-tag" data-tag="name">#name</span>`.
// The class carries the chip styling; the attribute holds the authoritative name so
// a DOM readback (readInlineFromDOM) reconstructs the tag exactly instead of
// re-scanning the `#name` text. The span holds a real `#name` text node, so the
// offset map counts it as `('#'+name).length` cells \u2014 the tag's width in the model.
export const TAG_CLASS = 'sk-tag';
export const TAG_ATTR = 'data-tag';
// A code block's syntax-highlight colour mirror (SKR-262) is an inert second
// <code> the painter appends INSIDE the <pre>, carrying colourised token spans
// behind the real editable text. It must stay the LAST child so the offset-walk
// fast path (a native Range that ends before it) never counts its text, and the
// caret walker skips its subtree by this attribute. Nothing in the model or a DOM
// readback ever sees it — it is pure paint.
export const HL_MIRROR_ATTR = 'data-hl-mirror';
// Surface chrome: an element the surface renders INSIDE a block that is presentation,
// not content (the code colour mirror, the code language corner button). It carries
// no model text, so the offset/caret walkers skip its subtree wholesale by this
// attribute, and it must sit AFTER the block's real editable content in DOM order so
// the offset fast path never counts it. Distinct from a contenteditable=false ATOM
// (a tag chip / frozen block), which IS content and carries a cell in the offset map.
export const CHROME_ATTR = 'data-sk-chrome';
// The class on a code block's language corner button, used by the surface's click
// handler to open the language picker (SKR-262 / SKR-3) and by CSS to reveal it on
// hover. The button is chrome (CHROME_ATTR), so it never disturbs the caret.
export const CODE_LANG_CLASS = 'sk-code-lang';
// A footnote reference (SKR-56) renders as a `<sup>` marked with this attribute so
// the offset walkers treat it as a SINGLE-CELL atom (like an image): one cell wide
// regardless of the label text inside, which the walker never descends into. The
// authoritative label rides `data-footnote-label` for DOM readback.
export const FOOTNOTE_REF_ATTR = 'data-footnote-ref';

// A small, deliberately calm hue palette for tag chips — spread around the wheel
// but skipping the garish bands (pure yellow / lime) so every tag reads gently.
// The chip's CSS mixes the chosen hue heavily toward the theme neutrals, so these
// are anchors, not the final saturated colors.
const TAG_HUES = [214, 190, 152, 32, 344, 268] as const; // blue, teal, green, amber, rose, violet

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/** The hue (0-360) a tag chip wears, chosen from {@link TAG_HUES} by hashing the
 *  tag's ROOT segment — so a family (`#project/q3`, `#project/q4`) shares one
 *  color while unrelated tags separate. Deterministic and storage-free. */
export function tagHue(name: string): number {
  const root = name.split('/')[0] || name;
  return TAG_HUES[Math.abs(hashString(root)) % TAG_HUES.length]!;
}

/**
 * Maps a Markdown image URL (as it lives in the model, e.g. the document-relative
 * `assets/foo.png` an image paste splices in — SKR-175) to a URL the webview can
 * actually load. This is a VIEW concern only: the model keeps the raw relative
 * path and serialization is untouched, so `.folio`/`.md` round-trips are byte-
 * identical. The real shell can't fetch a raw relative src against the app's
 * custom-scheme document origin, so it stays invisible (SKR-223); the registered
 * resolver rewrites it onto the asset origin the shell serves project files from
 * (`skrive-asset://…` — AssetSchemeHandler.swift / asset-protocol.ts). Absolute
 * and external URLs pass through untouched. The default is identity, so tests,
 * the latency harness, and any consumer that never registers one keep today's
 * literal behavior.
 */
export type AssetResolver = (rawUrl: string) => string;

const identityAssetResolver: AssetResolver = (url) => url;

// Wrap a node in an element, returning the wrapper. Innermost-first composition.
function wrap(tag: string, child: Node): HTMLElement {
  const el = document.createElement(tag);
  el.appendChild(child);
  return el;
}

// One inline leaf -> a DOM node, wrapped in its marks. Code innermost, link
// outermost — a stable nesting so the caret walk and incremental re-render see a
// consistent shape. Marks are presentation; they never change the flat character
// offset the selection model counts in.
function renderInlineNode(node: InlineNode, resolveAsset: AssetResolver): Node {
  let dom: Node;
  if (node.kind === 'text') {
    dom = document.createTextNode(node.text);
  } else if (node.kind === 'tag') {
    // A tag chip is a true atom: contentEditable=false, so the caret jumps over it
    // (WKWebView included) and a delete removes it as a unit. Its `#` lives in the
    // DOM text (so the offset map counts the tag as `('#'+name).length` cells,
    // matching the model) inside a `.sk-tag-hash` span the CSS suppresses, since the
    // leading tag glyph already signifies the tag; the name text follows.
    const span = document.createElement('span');
    span.className = TAG_CLASS;
    span.setAttribute(TAG_ATTR, node.name);
    span.style.setProperty('--sk-tag-hue', String(tagHue(node.name)));
    span.contentEditable = 'false';
    const hash = document.createElement('span');
    hash.className = 'sk-tag-hash';
    hash.textContent = '#';
    span.appendChild(hash);
    span.appendChild(document.createTextNode(node.name));
    dom = span;
  } else if (node.kind === 'image') {
    const img = document.createElement('img');
    // Checked on the MODEL url, before resolveAsset rewrites a relative path to
    // whatever origin the shell serves assets from — that resolved form is not
    // a URL the allowlist knows about (SKR-187 / F29).
    if (isSafeUrl(node.url)) img.src = resolveAsset(node.url);
    img.alt = node.alt;
    if (node.title != null) img.title = node.title;
    dom = img;
  } else if (node.kind === 'footnote_ref') {
    // A single-cell atom: contentEditable=false so the caret steps over it and a
    // delete removes it whole. The label text sits inside for display, but the
    // offset walker counts the whole <sup> as one cell (isAtomEl) and never reads
    // that text — the authoritative label is the data attribute, for DOM readback.
    const sup = document.createElement('sup');
    sup.className = 'sk-footnote-ref';
    sup.setAttribute(FOOTNOTE_REF_ATTR, '');
    sup.dataset.footnoteLabel = node.label;
    sup.contentEditable = 'false';
    sup.textContent = node.label;
    dom = sup;
  } else {
    const br = document.createElement('br');
    br.setAttribute(HARD_BREAK_ATTR, '');
    dom = br;
  }

  const marks: InlineMarks = node.marks;
  if (marks.code) {
    const codeEl = wrap('code', dom);
    // Code is code, not prose: no spellcheck squiggles inside inline code
    // (SKR-191; the surface itself has spellcheck on).
    codeEl.setAttribute('spellcheck', 'false');
    dom = codeEl;
  }
  if (marks.em) dom = wrap('em', dom);
  if (marks.strong) dom = wrap('strong', dom);
  if (marks.strikethrough) dom = wrap('s', dom);
  if (marks.underline) dom = wrap('u', dom);
  if (marks.link) {
    const a = document.createElement('a');
    // The second, independent URL check (SKR-187 / F29). Paste sanitizes at
    // ingestion, but a link can reach the model without passing through it — a
    // markdown link arriving as `text/plain`, a URL typed into the link editor,
    // a file authored elsewhere. An <a> with no href is inert, and leaving the
    // element in place keeps the inline structure the selection model counts on.
    if (isSafeUrl(marks.link.href)) a.href = marks.link.href;
    if (marks.link.title != null) a.title = marks.link.title;
    a.appendChild(dom);
    dom = a;
  }
  return dom;
}

// Set a code block's text, adding a <br> placeholder when the block is empty so
// it keeps height and an addressable caret — the same reason an empty inline run
// gets one. Without it an empty <code> has no child and WKWebView cannot place a
// caret inside it, so a fresh or fully-deleted code block becomes unenterable.
export function setCodeContent(code: HTMLElement, text: string): void {
  code.textContent = text;
  if (text === '') code.appendChild(document.createElement('br'));
}

// Render a block's inline content. An empty inline run still needs a <br> so the
// block has height and an addressable caret position.
function renderInline(nodes: InlineNode[], host: HTMLElement, resolveAsset: AssetResolver): void {
  if (nodes.length === 0) {
    host.appendChild(document.createElement('br'));
    return;
  }
  for (const node of nodes) host.appendChild(renderInlineNode(node, resolveAsset));
  // Content ending in a hard break opens an empty new line (the <br> ends the
  // current line). That line needs a zero-width caret filler so WKWebView can PAINT
  // a caret there: a caret anchored at the bare element position after the trailing
  // <br> commits but paints at the block start (the classic trailing-<br> problem,
  // WKWebView flavour). The U+200B filler is a real text node — the only anchor
  // WebKit paints reliably — and also gives the line its height. The offset map
  // treats it as zero-width and readInlineFromDOM strips it, so the model and the
  // flat offsets never see it (SKR-176).
  if (nodes[nodes.length - 1]!.kind === 'break') {
    host.appendChild(document.createTextNode(CARET_FILLER));
  }
}

function renderChildren(blocks: BlockNode[], host: HTMLElement, resolveAsset: AssetResolver): void {
  for (const block of blocks) host.appendChild(renderBlock(block, resolveAsset));
}

/** Replace a block element's inline content from the model. The block-local hot
 *  path calls this after an edit: the model is authoritative, the DOM is derived. */
export function renderInlineInto(
  host: HTMLElement,
  nodes: InlineNode[],
  resolveAsset: AssetResolver = identityAssetResolver
): void {
  host.textContent = '';
  renderInline(nodes, host, resolveAsset);
}

/**
 * Render one block (and, for containers, its descendants) to a DOM element
 * tagged with its block id. Pure: reads the model, allocates DOM, no side effects
 * beyond the returned tree.
 */
export function renderBlock(
  block: BlockNode,
  resolveAsset: AssetResolver = identityAssetResolver
): HTMLElement {
  let el: HTMLElement;
  switch (block.type) {
    case 'heading':
      el = document.createElement(`h${Math.min(6, Math.max(1, block.level))}`);
      renderInline(block.inline, el, resolveAsset);
      break;
    case 'paragraph':
      el = document.createElement('p');
      renderInline(block.inline, el, resolveAsset);
      break;
    case 'code_block': {
      el = document.createElement('pre');
      // Code is code, not prose: the surface's spellcheck (SKR-191) stops at
      // the fence.
      el.setAttribute('spellcheck', 'false');
      // The language drives syntax highlighting (SKR-262) and the fenced info
      // string on export; the highlight painter reads it from here. Empty means
      // no language, which degrades to plain monospace.
      if (block.lang) el.dataset.lang = block.lang;
      const code = document.createElement('code');
      setCodeContent(code, block.text);
      el.appendChild(code);
      // Language corner button (SKR-262 / SKR-3) — per-block chrome, on the block,
      // revealed on hover; clicking opens the language picker. It is chrome, not
      // content (CHROME_ATTR): appended AFTER the real code and skipped by the
      // offset/caret walkers, so it never disturbs editing. tabindex=-1 keeps it
      // out of the document's tab order (it is hover chrome, not a form field).
      const langBtn = document.createElement('button');
      langBtn.type = 'button';
      langBtn.className = CODE_LANG_CLASS;
      langBtn.setAttribute(CHROME_ATTR, '');
      langBtn.contentEditable = 'false';
      langBtn.tabIndex = -1;
      langBtn.textContent = languageLabel(block.lang);
      el.appendChild(langBtn);
      break;
    }
    case 'blockquote':
      el = document.createElement('blockquote');
      renderChildren(block.children, el, resolveAsset);
      break;
    case 'footnote_definition': {
      // Gathered into the document-end footer by orderForDisplay; the editable
      // definition body is its child blocks. The leading `[^label]` marker is a
      // chrome button (CHROME_ATTR, so the offset walkers skip it) that jumps back
      // to the reference. It is a direct child of the container, not inside an
      // inline block, so it never sits in a caret path.
      el = document.createElement('div');
      el.className = 'sk-footnote-def';
      el.dataset.footnoteLabel = block.label;
      const backref = document.createElement('button');
      backref.type = 'button';
      backref.className = 'sk-footnote-backref';
      backref.setAttribute(CHROME_ATTR, '');
      backref.contentEditable = 'false';
      backref.tabIndex = -1;
      backref.dataset.footnoteLabel = block.label;
      backref.textContent = `[^${block.label}]`;
      el.appendChild(backref);
      renderChildren(block.children, el, resolveAsset);
      break;
    }
    case 'bullet_list':
    case 'ordered_list': {
      if (block.type === 'ordered_list') {
        const ol = document.createElement('ol');
        ol.start = block.start;
        el = ol;
      } else {
        el = document.createElement('ul');
      }
      for (const item of block.items) {
        const li = document.createElement('li');
        // Per-item direction: each item's marker sits on its own text's side
        // (SKR-232), so one RTL item in an LTR list reads correctly.
        li.setAttribute('dir', 'auto');
        renderChildren(item.children, li, resolveAsset);
        el.appendChild(li);
      }
      break;
    }
    case 'horizontal_rule':
      el = document.createElement('hr');
      break;
    case 'table': {
      el = document.createElement('table');
      const tbody = document.createElement('tbody');
      block.rows.forEach((row, r) => {
        const tr = document.createElement('tr');
        row.forEach((cell, c) => {
          const cellEl = document.createElement(r === 0 ? 'th' : 'td');
          // Cells are inline, not blocks, so they carry coordinates (not a block
          // id); the surface edits a cell by (table id, row, col).
          cellEl.dataset.cellRow = String(r);
          cellEl.dataset.cellCol = String(c);
          // Cells resolve direction individually; the table element itself
          // stays direction-neutral so the COLUMN order never flips (SKR-232).
          cellEl.setAttribute('dir', 'auto');
          renderInline(cell, cellEl, resolveAsset);
          tr.appendChild(cellEl);
        });
        tbody.appendChild(tr);
      });
      el.appendChild(tbody);
      break;
    }
    case 'frozen_block':
      // Never editable in place (it can't be canonicalized, so there is nothing
      // to dirty-track): without this a plain div inherits the container's
      // contenteditable and the browser happily plants a native caret inside it
      // and lets you type — the model then silently ignores the keystrokes
      // (onBeforeInput no-ops on a non-inline leaf), leaving a dead caret sitting
      // in a block that looks editable but isn't (SKR-216). contentEditable=false
      // makes it a real atom: click-to-select (surface.ts's onClick) is the only
      // way in, matching code_block / table / hr's barrier status.
      el = document.createElement('div');
      el.dataset.frozen = '';
      el.contentEditable = 'false';
      el.textContent = block.src;
      break;
  }

  el.setAttribute(BLOCK_ID_ATTR, block.id);
  // Bidi (SKR-232): every block resolves its own direction from its first
  // strong character, so an RTL paragraph lays out RTL inside an LTR document
  // (and vice versa) — per-paragraph direction, the Docs/Word model. The lone
  // exception is the table ELEMENT: direction on a table reorders its columns,
  // so the table stays neutral and its cells (above) resolve individually.
  // The companion CSS (BlockEditor.css) uses logical properties
  // (border-inline-start etc.) so quote rules and list padding follow.
  if (block.type !== 'table') el.setAttribute('dir', 'auto');
  return el;
}

/**
 * The block-view registry: block id -> its top-level DOM element. Tolerates an
 * absent element by design (a `get` may return undefined), which is the seam
 * virtualization plugs into later — selection and commands already cope with a
 * block that is not currently in the DOM.
 */
export class BlockViewRegistry {
  private readonly views = new Map<string, HTMLElement>();

  set(id: string, el: HTMLElement): void {
    this.views.set(id, el);
  }
  /** The element for a block id, or undefined if it is not currently rendered. */
  get(id: string): HTMLElement | undefined {
    return this.views.get(id);
  }
  delete(id: string): void {
    this.views.delete(id);
  }
  clear(): void {
    this.views.clear();
  }
}

/**
 * Render a whole document into `container`, populating the registry with every
 * top-level block's element. Replaces any prior content.
 */
/** Visual order for the surface: body blocks in model order, then every footnote
 *  definition (SKR-56) in model order — so definitions gather into a document-end
 *  footer while the MODEL keeps their authored position (the `.md` round-trip stays
 *  byte-stable). Returns the input array unchanged when there are no definitions,
 *  the common case, so nothing is allocated. */
export function orderForDisplay(blocks: BlockNode[]): BlockNode[] {
  let hasDef = false;
  for (const b of blocks) {
    if (b.type === 'footnote_definition') {
      hasDef = true;
      break;
    }
  }
  if (!hasDef) return blocks;
  const body: BlockNode[] = [];
  const defs: BlockNode[] = [];
  for (const b of blocks) (b.type === 'footnote_definition' ? defs : body).push(b);
  return [...body, ...defs];
}

export function renderDocument(
  container: HTMLElement,
  blocks: BlockNode[],
  registry: BlockViewRegistry,
  resolveAsset: AssetResolver = identityAssetResolver
): void {
  container.textContent = '';
  registry.clear();
  for (const block of orderForDisplay(blocks)) {
    const el = renderBlock(block, resolveAsset);
    registry.set(block.id, el);
    container.appendChild(el);
  }
}
