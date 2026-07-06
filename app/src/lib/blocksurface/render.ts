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

export const BLOCK_ID_ATTR = 'data-block-id';
// Marks a rendered hard-break atom so the offset mapping can tell it apart from
// the bare <br> an empty block needs for height/caret (which has zero width in
// the model). Only real breaks carry a cell in the offset space (SKR-155).
export const HARD_BREAK_ATTR = 'data-hard-break';

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
  } else if (node.kind === 'image') {
    const img = document.createElement('img');
    img.src = resolveAsset(node.url);
    img.alt = node.alt;
    if (node.title != null) img.title = node.title;
    dom = img;
  } else {
    const br = document.createElement('br');
    br.setAttribute(HARD_BREAK_ATTR, '');
    dom = br;
  }

  const marks: InlineMarks = node.marks;
  if (marks.code) dom = wrap('code', dom);
  if (marks.em) dom = wrap('em', dom);
  if (marks.strong) dom = wrap('strong', dom);
  if (marks.strikethrough) dom = wrap('s', dom);
  if (marks.link) {
    const a = document.createElement('a');
    a.href = marks.link.href;
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
      const code = document.createElement('code');
      setCodeContent(code, block.text);
      el.appendChild(code);
      break;
    }
    case 'blockquote':
      el = document.createElement('blockquote');
      renderChildren(block.children, el, resolveAsset);
      break;
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
export function renderDocument(
  container: HTMLElement,
  blocks: BlockNode[],
  registry: BlockViewRegistry,
  resolveAsset: AssetResolver = identityAssetResolver
): void {
  container.textContent = '';
  registry.clear();
  for (const block of blocks) {
    const el = renderBlock(block, resolveAsset);
    registry.set(block.id, el);
    container.appendChild(el);
  }
}
