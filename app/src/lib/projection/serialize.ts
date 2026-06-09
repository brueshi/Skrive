// ProseMirror -> Markdown, splice-untouched. The whole bet lives here:
//   - A clean block emits its verbatim `src` — byte-identical, no normalization.
//   - A frozen block always emits its verbatim `src`.
//   - A dirty block serializes canonically, UNLESS the idempotence guard finds
//     that its canonical form re-parses to the same tree as the original `src`
//     (an edit that was reverted, or a no-op), in which case the original bytes
//     are restored.
//   - Gaps are reconstructed at the SEAM: a captured gap (string, possibly '')
//     emits verbatim; a new seam (gapBefore === null, from a block created during
//     editing) emits the canonical separator. Gap fidelity therefore depends on
//     whether the seam is known, never on whether the block's content changed.

import type { Node as PMNode } from 'prosemirror-model';
import type { Heading, Paragraph, PhrasingContent, Root } from 'mdast';
import { unified } from 'unified';
import remarkStringify from 'remark-stringify';
import { parseMarkdown } from './mdast';

// Structural mdast equality ignoring `position`. Short-circuits on the first
// difference and allocates nothing. This replaces a
// `JSON.stringify(stripPositions(tree))` compare that, per guard check, cloned a
// whole position-stripped tree and serialized two trees to strings — three
// tree-sized allocations that were the dominant GC fuel in a snapshot. Key order
// is ignored, so it is at least as permissive as the old string compare (both
// operands come from the same parser, so order matched anyway).
// Exported for the dirty-corpus fidelity gate, which asserts exactly this
// relation between a fully-dirtied serialization and the original document.
export function mdastEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!mdastEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k in ao) {
      if (k === 'position') continue;
      if (!mdastEqual(ao[k], bo[k])) return false;
    }
    for (const k in bo) {
      if (k === 'position') continue;
      if (!(k in ao)) return false;
    }
    return true;
  }
  return false;
}

// Both guard operands cache their parsed trees by string, bounded by a coarse
// clear so a long session can't grow them without limit; they are pure perf
// caches, so dropping entries only costs a re-parse (mdastEqual only reads the
// trees, never mutates). The two operands live in separate maps because their
// lifetimes differ: a block's `src` is stable for as long as the block is being
// edited and its entry is hit on every snapshot, while the `canonical` side
// churns with the content — caching it converts the recurring forms
// (type-then-undo loops, several blocks sharing one canonical shape,
// re-serialization after a surface switch) into hits without ever evicting the
// long-lived src entries.
const TREE_CACHE_LIMIT = 1024;
const srcTreeCache = new Map<string, Root>();
const canonicalTreeCache = new Map<string, Root>();
function cachedTree(cache: Map<string, Root>, md: string): Root {
  const hit = cache.get(md);
  if (hit !== undefined) return hit;
  const tree = parseMarkdown(md);
  if (cache.size >= TREE_CACHE_LIMIT) cache.clear();
  cache.set(md, tree);
  return tree;
}

// Two Markdown strings are "semantically equal" when they parse to the same
// mdast tree (ignoring source positions). This is what lets edit-then-revert
// restore the original bytes instead of baking in normalization.
function semanticallyEqual(canonical: string, src: string): boolean {
  return mdastEqual(cachedTree(canonicalTreeCache, canonical), cachedTree(srcTreeCache, src));
}

// ---- canonical inline serialization (the F3 fix) ------------------------------
//
// The canonical inline path must produce Markdown that re-parses (via the same
// parseMarkdown) to a tree mdast-equal to what the PM block represents. That is
// CommonMark escaping in full: backslash-escaping text that would re-parse as
// markup, line-start escaping of block openers (`> `, `# `, `1. `), code-span
// fences longer than any backtick run inside the span, link-destination and
// link-title quoting, and the attention (emphasis/strong) adjacency rules.
// Hand-rolling that means owning every CommonMark edge case forever, so instead
// the PM inline runs are rebuilt into a small mdast inline tree and serialized
// through remark-stringify — i.e. mdast-util-to-markdown, which has been
// hardened against exactly these cases for years and is already in the tree (it
// is only reachable *through* remark-stringify under bun's isolated installs).
// `*` emphasis/strong matches the canonical style this serializer already emits.
const stringifier = unified().use(remarkStringify, { emphasis: '*', strong: '*' });

// Serialize a single mdast block. remark-stringify terminates the document with
// a newline; block joining is this serializer's job, so strip it.
function mdastBlockToMarkdown(block: Heading | Paragraph): string {
  const out = String(stringifier.stringify({ type: 'root', children: [block] } as Root));
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

type LinkRef = { href: string; title: string | null };

// A flat inline run: one leaf (text, code span, image, or hard break) plus the
// mark context it sits in. The PM document stores marks as flat normalized sets;
// these runs are the intermediate from which the nested mdast tree is rebuilt.
type InlineItem = { em: boolean; strong: boolean; link: LinkRef | null } & (
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'image'; url: string; alt: string; title: string | null }
  | { kind: 'break' }
);

function sameInlineContext(a: InlineItem, b: InlineItem): boolean {
  if (a.em !== b.em || a.strong !== b.strong) return false;
  if (a.link === null || b.link === null) return a.link === b.link;
  return a.link.href === b.link.href && a.link.title === b.link.title;
}

// Flatten a block's inline content into runs, coalescing adjacent text with the
// same context (PM may hold a just-extended bold span as two adjacent strong
// text nodes). In a context that cannot hold a line break (a table cell — rows
// are single lines), a hard break degrades to a single space: the same
// rationale as escapeTableCell's newline collapse.
function collectInline(node: PMNode, breaks: 'keep' | 'space'): InlineItem[] {
  const items: InlineItem[] = [];
  node.forEach((child) => {
    const names = new Set(child.marks.map((m) => m.type.name));
    const linkMark = child.marks.find((m) => m.type.name === 'link');
    const context = {
      em: names.has('em'),
      strong: names.has('strong'),
      link: linkMark
        ? {
            href: String(linkMark.attrs.href),
            title: linkMark.attrs.title != null ? String(linkMark.attrs.title) : null
          }
        : null
    };
    let item: InlineItem | null = null;
    if (child.isText) {
      const text = child.text ?? '';
      if (text) item = { ...context, kind: names.has('code') ? 'code' : 'text', text };
    } else if (child.type.name === 'image') {
      item = {
        ...context,
        kind: 'image',
        url: String(child.attrs.url),
        alt: String(child.attrs.alt),
        title: child.attrs.title != null ? String(child.attrs.title) : null
      };
    } else if (child.type.name === 'hard_break') {
      item = breaks === 'space' ? { ...context, kind: 'text', text: ' ' } : { ...context, kind: 'break' };
    }
    if (!item) return;
    const prev = items[items.length - 1];
    if (
      prev &&
      prev.kind === item.kind &&
      (item.kind === 'text' || item.kind === 'code') &&
      (prev.kind === 'text' || prev.kind === 'code') &&
      sameInlineContext(prev, item)
    ) {
      prev.text += item.text;
    } else {
      items.push(item);
    }
  });
  return items;
}

type Wrapper = 'em' | 'strong' | 'link';

// Outer-wrapper preference when the lookahead ties — i.e. a span where two or
// more marks are exactly coextensive. PM normalizes mark order, so the original
// nesting of coextensive marks is unrecoverable; this order is chosen so the
// common written forms survive re-parse exactly: `***x***` parses em-outside-
// strong (so em must wrap first), and a fully-bold link is conventionally
// written `**[label](url)**` (strong before link). The minority forms
// (`**_x_**`, `[**label**](url)`) canonicalize to the majority nesting when
// dirtied — identical rendering, flipped tree.
const WRAPPER_PRIORITY: readonly Wrapper[] = ['em', 'strong', 'link'];

// A wrapper's grouping key at one run: null when the run does not carry the
// mark; links key on href+title so differently-targeted adjacent links never
// merge.
function wrapperKey(item: InlineItem, w: Wrapper): string | null {
  if (w === 'em') return item.em ? 'em' : null;
  if (w === 'strong') return item.strong ? 'strong' : null;
  return item.link ? `${item.link.href}\u0000${item.link.title ?? '\u0000'}` : null;
}

function withoutWrapper(item: InlineItem, w: Wrapper): InlineItem {
  if (w === 'em') return { ...item, em: false };
  if (w === 'strong') return { ...item, strong: false };
  return { ...item, link: null };
}

function leafToMdast(item: InlineItem): PhrasingContent {
  switch (item.kind) {
    case 'code':
      return { type: 'inlineCode', value: item.text };
    case 'image':
      return { type: 'image', url: item.url, alt: item.alt, title: item.title };
    case 'break':
      return { type: 'break' };
    default:
      return { type: 'text', value: item.text };
  }
}

// Rebuild the nested mdast inline tree from the flat runs. Greedy with
// lookahead: at each run, open the wrapper whose identical key extends over the
// most following runs, so a mark spanning several differently-marked runs
// becomes ONE node containing them — `*a**b***` is em(a, strong(b)), not
// em(a) + strong(em(b)), and those parse differently. Outside the coextensive
// ties WRAPPER_PRIORITY arbitrates, this reconstruction is exact.
function buildPhrasing(items: InlineItem[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (!item) break;
    let best: Wrapper | null = null;
    let bestLen = 0;
    for (const w of WRAPPER_PRIORITY) {
      const key = wrapperKey(item, w);
      if (key === null) continue;
      let j = i + 1;
      while (j < items.length) {
        const next = items[j];
        if (!next || wrapperKey(next, w) !== key) break;
        j++;
      }
      if (j - i > bestLen) {
        best = w;
        bestLen = j - i;
      }
    }
    if (best === null) {
      out.push(leafToMdast(item));
      i++;
      continue;
    }
    const chosen = best;
    const inner = buildPhrasing(
      items.slice(i, i + bestLen).map((it) => withoutWrapper(it, chosen))
    );
    if (chosen === 'em') out.push({ type: 'emphasis', children: inner });
    else if (chosen === 'strong') out.push({ type: 'strong', children: inner });
    else if (item.link) {
      out.push({ type: 'link', url: item.link.href, title: item.link.title, children: inner });
    }
    i += bestLen;
  }
  return out;
}

// PM inline content -> canonical Markdown, in paragraph context (line-start
// block openers like `> ` get escaped). Used for paragraphs and table cells.
function canonicalInline(node: PMNode, breaks: 'keep' | 'space'): string {
  const children = buildPhrasing(collectInline(node, breaks));
  if (children.length === 0) return '';
  return mdastBlockToMarkdown({ type: 'paragraph', children });
}

// A heading serializes as a whole mdast heading so the library owns the heading-
// specific safety rules: a hard break (only reachable from a setext source —
// ATX headings cannot contain one) keeps the heading on one parse by emitting
// setext for depth 1-2 and collapsing to a space for depth 3+, instead of the
// `\`+newline that used to split the block into heading + paragraph (F5).
function canonicalHeading(block: PMNode): string {
  const depth = Math.min(6, Math.max(1, Number(block.attrs.level) || 1)) as Heading['depth'];
  const children = buildPhrasing(collectInline(block, 'keep'));
  return mdastBlockToMarkdown({ type: 'heading', depth, children });
}

// F4: a code fence is reproduced from the source (``` vs ~~~ and its length) and
// kept LONGER than any same-character run in the body — otherwise a body line of
// backticks closes the fence early and the block re-parses as code + paragraph +
// code. A fresh or indented block gets backticks, switching to tildes when the
// info string itself contains a backtick (CommonMark forbids backticks in a
// backtick fence's info string).
function canonicalCodeBlock(block: PMNode): string {
  const body = block.textContent;
  const lang = block.attrs.lang ? String(block.attrs.lang) : '';
  const meta = block.attrs.meta ? String(block.attrs.meta) : '';
  const info = meta ? `${lang} ${meta}` : lang;
  const captured: string | null = typeof block.attrs.fence === 'string' ? block.attrs.fence : null;
  const ch = captured !== null && captured.startsWith('~') ? '~' : info.includes('`') ? '~' : '`';
  const runs = body.match(ch === '`' ? /`+/g : /~+/g);
  let longest = 0;
  if (runs) for (const r of runs) longest = Math.max(longest, r.length);
  const capturedLen = captured !== null && captured.startsWith(ch) ? captured.length : 0;
  const fence = ch.repeat(Math.max(3, capturedLen, longest + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}

// A list serializes item by item. Each item opens with its marker prefix; every
// continuation line — wrapped content, an extra paragraph, a nested sub-list —
// is indented to the marker's width so it stays inside the item under CommonMark.
// A loose list (`spread`) blank-line-separates its items; the blocks WITHIN an
// item follow the item's own spread (a loose list can hold a tight item, and the
// re-parsed listItem.spread reflects exactly that). Recurses through
// canonicalBlock, so nested lists indent at each level.
function serializeList(block: PMNode): string {
  const ordered = block.type.name === 'ordered_list';
  const spread = block.attrs.spread === true;
  const marker = block.attrs.marker ? String(block.attrs.marker) : '-';
  const start: number = typeof block.attrs.start === 'number' ? block.attrs.start : 1;
  const delimiter = block.attrs.delimiter === ')' ? ')' : '.';

  const items: string[] = [];
  block.forEach((item, _offset, index) => {
    const prefix = ordered ? `${start + index}${delimiter} ` : `${marker} `;
    const indent = ' '.repeat(prefix.length);

    const childBlocks: string[] = [];
    item.forEach((child) => childBlocks.push(canonicalBlock(child)));
    const body = childBlocks.join(item.attrs.spread === true ? '\n\n' : '\n');

    const rendered = body
      .split('\n')
      .map((line, i) => {
        if (i === 0) return prefix + line; // the opening paragraph carries the marker
        return line.length > 0 ? indent + line : ''; // continuation, blanks stay blank
      })
      .join('\n');
    items.push(rendered);
  });

  return items.join(spread ? '\n\n' : '\n');
}

// A blockquote serializes by canonically serializing its child blocks, joining
// them with a blank line, then quoting every line: `> ` before content, a bare
// `>` for the blank separators. Recurses through canonicalBlock, so a nested
// blockquote or a heading inside the quote is quoted at each level.
function quotedBlockquote(block: PMNode): string {
  const parts: string[] = [];
  block.forEach((child) => parts.push(canonicalBlock(child)));
  return parts
    .join('\n\n')
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

// A pipe inside a GFM table cell must be escaped, and a cell is a single line —
// any stray newline (from a hard break) would split the row, so collapse it.
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// PM table -> canonical GFM: a header row, an alignment delimiter row derived
// from the header cells' `align` attr, then the body rows. Cells serialize their
// inline content through canonicalInline (so marks survive, with hard breaks
// degraded to spaces — a row is a single line) and pipes escaped on top.
// Minimal padding — `| a | b |` — which re-parses to the same table, so this is a
// fixpoint; an untouched table is restored verbatim by the idempotence guard.
function serializeTable(block: PMNode): string {
  const rows: PMNode[] = [];
  block.forEach((row) => rows.push(row));
  const header = rows[0];
  if (!header) return '';

  const rowLine = (row: PMNode): string => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(escapeTableCell(canonicalInline(cell, 'space'))));
    return `| ${cells.join(' | ')} |`;
  };

  const delimiters: string[] = [];
  header.forEach((cell) => {
    const align = cell.attrs.align;
    delimiters.push(
      align === 'left'
        ? ':---'
        : align === 'right'
          ? '---:'
          : align === 'center'
            ? ':---:'
            : '---'
    );
  });

  const lines = [rowLine(header), `| ${delimiters.join(' | ')} |`];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row) lines.push(rowLine(row));
  }
  return lines.join('\n');
}

function canonicalBlock(block: PMNode): string {
  switch (block.type.name) {
    case 'blockquote':
      return quotedBlockquote(block);
    case 'table':
      return serializeTable(block);
    case 'heading':
      return canonicalHeading(block);
    case 'code_block':
      return canonicalCodeBlock(block);
    case 'bullet_list':
    case 'ordered_list':
      return serializeList(block);
    case 'horizontal_rule':
      // Canonical form for a freshly-inserted rule. A parsed rule with a
      // different marker (`***`, `___`) is dirty-equal to this under the
      // idempotence guard, so its original bytes are restored.
      return '---';
    case 'paragraph':
    default:
      return canonicalInline(block, 'keep');
  }
}

// serializeBlock is a pure function of its (immutable) block node, so memoize it
// by node identity. ProseMirror structurally shares unchanged nodes across
// document versions, so across debounced snapshots only the block actually
// edited since the last snapshot is a fresh reference and recomputes; every other
// block — clean or dirty — is a cache hit. This bounds a snapshot to the one
// changed block rather than re-running the parse-heavy idempotence guard for
// every dirty block accumulated over a writing session. The WeakMap lets entries
// for superseded node versions be collected on their own.
const blockCache = new WeakMap<PMNode, string>();

function serializeBlock(block: PMNode): string {
  const cached = blockCache.get(block);
  if (cached !== undefined) return cached;
  const result = serializeBlockUncached(block);
  blockCache.set(block, result);
  return result;
}

function serializeBlockUncached(block: PMNode): string {
  // Frozen blocks are verbatim by construction and carry no `dirty` state.
  if (block.type.name === 'frozen_block') return String(block.attrs.src ?? '');

  const src: string | null = block.attrs.src;
  if (!block.attrs.dirty && src != null) return src;

  const canonical = canonicalBlock(block);
  if (src != null && semanticallyEqual(canonical, src)) return src;
  return canonical;
}

// The gap at the seam before a block. A captured seam (string) is authoritative;
// a new seam (null) is reconstructed: nothing before the first block, the
// standard blank-line separator between top-level blocks otherwise.
function gapForSeam(block: PMNode, index: number): string {
  const captured: string | null = block.attrs.gapBefore ?? null;
  if (captured != null) return captured;
  return index === 0 ? '' : '\n\n';
}

export function serializeDoc(doc: PMNode): string {
  let out = '';
  doc.forEach((block, _offset, index) => {
    out += gapForSeam(block, index);
    out += serializeBlock(block);
  });
  out += doc.attrs.trailingGap;
  return out;
}
