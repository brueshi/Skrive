// Markdown -> mdast -> ProseMirror, capturing the source map.
//
// We parse with mdast-util-from-markdown (which carries byte offsets on every
// node), then map each top-level block to a PM node, slicing its verbatim source
// and the gap before it straight out of the original string. The inline
// structure is mapped faithfully so a *dirty* block can serialize canonically,
// but for a *clean* block the inline tree is never consulted — `src` wins.
//
// Anything the schema does not model richly (tables, HTML, loose or nested
// lists) becomes a `frozen_block`: it round-trips verbatim and is never
// canonicalized, so it cannot be corrupted by an edit.

import type { Node as PMNode, Mark } from 'prosemirror-model';
import type {
  Code,
  RootContent,
  PhrasingContent,
  List,
  ListItem,
  Table
} from 'mdast';
import { schema } from './schema';
import { parseMarkdown } from './mdast';

type WithOffsets = { position?: { start: { offset?: number }; end: { offset?: number } } };

function offsetStart(node: WithOffsets, fallback: number): number {
  return node.position?.start?.offset ?? fallback;
}
function offsetEnd(node: WithOffsets, fallback: number): number {
  return node.position?.end?.offset ?? fallback;
}

// Map mdast phrasing content to PM inline nodes. Returns null on the first
// construct the schema cannot canonically reproduce from the block alone — raw
// inline HTML (a paragraph projection would lose the html/text distinction the
// moment escaping touches it) and reference-style links/images (their
// definitions live elsewhere in the document, outside this block's bytes). A
// null tells the caller to freeze the containing block verbatim: the same
// philosophy childBlockToPM applies to unmodeled child blocks.
function inlineToPM(nodes: PhrasingContent[] | undefined, marks: readonly Mark[]): PMNode[] | null {
  if (!nodes) return [];
  const out: PMNode[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        if (n.value) out.push(schema.text(n.value, marks as Mark[]));
        break;
      case 'inlineCode':
        if (n.value) out.push(schema.text(n.value, schema.marks.code.create().addToSet(marks)));
        break;
      case 'emphasis': {
        const kids = inlineToPM(n.children, schema.marks.em.create().addToSet(marks));
        if (!kids) return null;
        out.push(...kids);
        break;
      }
      case 'strong': {
        const kids = inlineToPM(n.children, schema.marks.strong.create().addToSet(marks));
        if (!kids) return null;
        out.push(...kids);
        break;
      }
      case 'link': {
        const kids = inlineToPM(
          n.children,
          schema.marks.link
            .create({ href: n.url ?? '', title: n.title ?? null })
            .addToSet(marks)
        );
        if (!kids) return null;
        out.push(...kids);
        break;
      }
      case 'image':
        out.push(
          schema.nodes.image.create(
            { url: n.url ?? '', alt: n.alt ?? '', title: n.title ?? null },
            null,
            marks as Mark[]
          )
        );
        break;
      case 'break':
        // A hard line break -> the dedicated node (renders as <br>), not a bare
        // `\n` text (which would render as a space). It carries the surrounding
        // marks so a break inside emphasis stays inside the emphasis when the
        // serializer rebuilds the inline tree — em(a, break, b) and
        // em(a), break, em(b) parse to different trees.
        out.push(schema.nodes.hard_break.create(null, null, marks as Mark[]));
        break;
      default:
        // html, linkReference, imageReference — and anything the parser may
        // grow. Freezing beats degrading to lossy plain text.
        return null;
    }
  }
  return out;
}

function frozen(src: string, gapBefore: string): PMNode {
  return schema.node('frozen_block', { src, gapBefore });
}

// The literal marker style is not on the mdast node, so we read it back from the
// source at the list's byte offset. `md.slice` from there begins at the first
// item's marker (after any nesting indent, which the `\s*` absorbs). This keeps
// a dirty nested list in the writer's own `*`/`+`/`)` rather than churning it to
// one canonical form — the same style-fidelity rule top-level lists already get.
function bulletMarker(node: List, md: string): string {
  const off = offsetStart(node, 0);
  return md.slice(off, off + 8).match(/^\s*([-*+])/)?.[1] ?? '-';
}
function orderedDelimiter(node: List, md: string): string {
  const off = offsetStart(node, 0);
  return md.slice(off, off + 16).match(/^\s*\d+([.)])/)?.[1] ?? '.';
}

// The literal opening fence ('```', '~~~~', ...) is not on the mdast node either,
// so read it from the source at the node's offset (the position starts at the
// fence, after any container prefix). Indented code has no fence -> null, and
// the serializer promotes it to a fenced block on first edit — an accepted
// normalization, since both forms parse to the same mdast `code` node.
function fenceOf(node: Code, md: string): string | null {
  const off = offsetStart(node, 0);
  const lineEnd = md.indexOf('\n', off);
  const firstLine = md.slice(off, lineEnd === -1 ? md.length : lineEnd);
  return firstLine.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? null;
}

function codeAttrs(node: Code, md: string): Record<string, unknown> {
  return { lang: node.lang ?? '', meta: node.meta ?? null, fence: fenceOf(node, md) };
}

// A list item's children: an opening paragraph followed by any further blocks
// (nested sub-lists, extra paragraphs in a loose item). Returns null — freezing
// the whole list — if the item is empty, does not open with a paragraph (PM's
// `paragraph block*` rule), or holds a child we cannot model.
function mapListItemChildren(item: ListItem, md: string): PMNode[] | null {
  const kids: PMNode[] = [];
  for (const child of item.children ?? []) {
    const pm = childBlockToPM(child, md);
    if (!pm) return null;
    kids.push(pm);
  }
  if (kids.length === 0 || kids[0]?.type.name !== 'paragraph') return null;
  return kids;
}

// Map an mdast list (top-level or nested) to a PM list node, preserving marker
// style, ordinal start, delimiter, and loose/tight rhythm. `base` carries the
// source map for a top-level list; nested lists pass none (they ride their
// container's verbatim `src`). Returns null if any item is unmappable.
function listToPM(node: List, md: string, base?: Record<string, unknown>): PMNode | null {
  const items: PMNode[] = [];
  for (const item of node.children ?? []) {
    const kids = mapListItemChildren(item, md);
    if (!kids) return null;
    items.push(schema.node('list_item', { spread: item.spread === true }, kids));
  }
  if (items.length === 0) return null;

  const common = base ?? {};
  const spread = node.spread === true;
  if (node.ordered) {
    return schema.node(
      'ordered_list',
      { ...common, start: node.start ?? 1, delimiter: orderedDelimiter(node, md), spread },
      items
    );
  }
  return schema.node('bullet_list', { ...common, marker: bulletMarker(node, md), spread }, items);
}

// Map an mdast block for use INSIDE a modeled container (a blockquote; later,
// list items). No per-block source map: the container owns the verbatim `src`
// and only re-serializes its children canonically when the container is dirtied.
// Returns null for any construct we cannot canonically reproduce, which tells
// the caller to freeze the whole container verbatim rather than model it lossily.
function childBlockToPM(node: RootContent, md: string): PMNode | null {
  switch (node.type) {
    case 'paragraph': {
      const inline = inlineToPM(node.children, []);
      return inline ? schema.node('paragraph', {}, inline) : null;
    }
    case 'heading': {
      const inline = inlineToPM(node.children, []);
      return inline ? schema.node('heading', { level: node.depth }, inline) : null;
    }
    case 'code':
      return schema.node(
        'code_block',
        codeAttrs(node, md),
        node.value ? [schema.text(node.value)] : []
      );
    case 'thematicBreak':
      return schema.node('horizontal_rule', {});
    case 'list':
      return listToPM(node, md);
    case 'blockquote': {
      const kids = mapChildBlocks(node.children, md);
      return kids ? schema.node('blockquote', {}, kids) : null;
    }
    default:
      // Tables are deferred to Stage 2.5d; raw HTML stays frozen by design.
      // A container holding one is frozen as a whole, never modeled lossily.
      return null;
  }
}

function mapChildBlocks(children: RootContent[], md: string): PMNode[] | null {
  const out: PMNode[] = [];
  for (const child of children) {
    const pm = childBlockToPM(child, md);
    if (!pm) return null;
    out.push(pm);
  }
  return out.length > 0 ? out : null;
}

// mdast table -> PM table. The first row is the header (table_header cells), the
// rest are body rows (table_cell). GFM column alignment lives on the mdast
// table's `align` array; we stamp it onto each cell so the serializer can rebuild
// the delimiter row. Rows are forced rectangular to the header's column count —
// short rows pad with empty cells, long rows truncate — because prosemirror-tables
// requires a rectangular grid. Returns null (freeze) for a degenerate empty table.
function tableToPM(node: Table, base?: Record<string, unknown>): PMNode | null {
  const rowsM = node.children ?? [];
  if (rowsM.length === 0) return null;
  const colCount = (rowsM[0]?.children ?? []).length;
  if (colCount === 0) return null;
  const align = node.align ?? [];

  const rows: PMNode[] = [];
  for (let rowIndex = 0; rowIndex < rowsM.length; rowIndex++) {
    const row = rowsM[rowIndex];
    const cellType = rowIndex === 0 ? 'table_header' : 'table_cell';
    const cells: PMNode[] = [];
    for (let col = 0; col < colCount; col++) {
      const cell = row?.children?.[col];
      const inline = cell ? inlineToPM(cell.children, []) : [];
      if (!inline) return null; // unmappable cell content -> freeze the table
      cells.push(schema.node(cellType, { align: align[col] ?? null }, inline));
    }
    rows.push(schema.node('table_row', {}, cells));
  }
  return schema.node('table', base ?? {}, rows);
}

function blockToPM(node: RootContent, src: string, gapBefore: string, md: string): PMNode {
  const base = { src, gapBefore, dirty: false };
  switch (node.type) {
    case 'heading': {
      const inline = inlineToPM(node.children, []);
      if (!inline) return frozen(src, gapBefore);
      return schema.node('heading', { ...base, level: node.depth }, inline);
    }
    case 'code':
      return schema.node(
        'code_block',
        { ...base, ...codeAttrs(node, md) },
        node.value ? [schema.text(node.value)] : []
      );
    case 'paragraph': {
      const inline = inlineToPM(node.children, []);
      if (!inline) return frozen(src, gapBefore);
      return schema.node('paragraph', base, inline);
    }
    case 'thematicBreak':
      return schema.node('horizontal_rule', base);
    case 'blockquote': {
      const kids = mapChildBlocks(node.children, md);
      if (!kids) return frozen(src, gapBefore);
      return schema.node('blockquote', base, kids);
    }
    case 'list':
      return listToPM(node, md, base) ?? frozen(src, gapBefore);
    case 'table':
      return tableToPM(node, base) ?? frozen(src, gapBefore);
    default:
      // HTML, definition, footnote, etc.: preserved verbatim, never
      // canonicalized. (A table nested inside a quote/list still freezes its
      // container via childBlockToPM's default — out of 2.5d scope.)
      return frozen(src, gapBefore);
  }
}

// A Text<->Rich surface switch re-projects the exact Markdown the other surface
// just serialized, so a full from-scratch parse there is pure waste. One
// remembered (md, doc) pair covers it: PM documents are immutable, so handing
// the same doc back to a second caller is safe sharing, not aliasing.
let lastParse: { md: string; doc: PMNode } | null = null;

export function parseDoc(md: string): PMNode {
  if (lastParse !== null && lastParse.md === md) return lastParse.doc;
  const doc = parseDocFresh(md);
  lastParse = { md, doc };
  return doc;
}

function parseDocFresh(md: string): PMNode {
  const root = parseMarkdown(md);
  const children = root.children ?? [];

  const blocks: PMNode[] = [];
  let prevEnd = 0;
  for (const child of children) {
    const start = offsetStart(child, prevEnd);
    const end = offsetEnd(child, start);
    const gapBefore = md.slice(prevEnd, start);
    const src = md.slice(start, end);
    blocks.push(blockToPM(child, src, gapBefore, md));
    prevEnd = end;
  }
  const trailingGap = md.slice(prevEnd);

  // An empty document still needs one block to satisfy `block+`.
  if (blocks.length === 0) blocks.push(schema.node('paragraph', { src: '', gapBefore: '' }));

  return schema.node('doc', { trailingGap }, blocks);
}
