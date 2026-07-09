// Markdown -> the canonical block model (SKR-96). Parse with the shared mdast
// parser (which carries byte offsets on every node), then map each top-level
// block, slicing its verbatim `src` and the gap before it straight out of the
// original string — exactly as the projection parser does, building block-model
// nodes instead of ProseMirror nodes.
//
// Two block-model-specific jobs on top of the projection parser's:
//   - Assign each block a stable id (restored from a `<!-- sk:ID -->` anchor
//     comment where present, freshly generated otherwise).
//   - Consume the anchor comment so it never becomes content: the durable id is
//     bound to the following block, and the comment is reconstructed at save.
//
// Anything the model does not represent richly (raw inline HTML, reference links,
// loose/nested constructs we cannot canonically reproduce) becomes a frozen
// block: it round-trips verbatim and is never canonicalized, so an edit cannot
// corrupt it.

import type { Code, List, ListItem as MdListItem, PhrasingContent, RootContent, Table } from 'mdast';
import { normalizeLineEndings, parseMarkdown } from '../markdown-core';
import { parseAnchorComment } from './anchor';
import { generateBlockId } from './id';
import type {
  BlockNode,
  Document,
  FrozenBlock,
  InlineMarks,
  InlineNode,
  ListItem,
  TableAlign,
  TableCell
} from './types';

export type ParseOptions = {
  /** Block id generator. Inject a deterministic one for tests. */
  generateId?: () => string;
  /** Treat raw INLINE HTML (`a <span> b`) as literal text instead of freezing the
   *  paragraph that holds it. Off by default so file-open / parity keep the safe
   *  frozen classification; the paste path opts in so prose carrying a stray tag
   *  stays editable (the tag renders literally) — SKR-174 / F27. Block-level HTML
   *  is untouched either way: it never reaches inline mapping. */
  inlineHtmlAsText?: boolean;
};

type ParseCtx = { md: string; genId: () => string; inlineHtmlAsText: boolean };

type WithOffsets = { position?: { start: { offset?: number }; end: { offset?: number } } };
function offsetStart(node: WithOffsets, fallback: number): number {
  return node.position?.start?.offset ?? fallback;
}
function offsetEnd(node: WithOffsets, fallback: number): number {
  return node.position?.end?.offset ?? fallback;
}

// The fidelity base every top-level block carries.
type BlockBaseInit = {
  id: string;
  durable: boolean;
  src: string | null;
  gapBefore: string | null;
  dirty: boolean;
};

function topBase(id: string, durable: boolean, src: string, gapBefore: string): BlockBaseInit {
  return { id, durable, src, gapBefore, dirty: false };
}
function nestedBase(genId: () => string): BlockBaseInit {
  // Nested blocks (a blockquote's children, a list item's blocks) ride their
  // container's verbatim `src`, so they carry no source map and are never
  // independently anchored.
  return { id: genId(), durable: false, src: null, gapBefore: null, dirty: false };
}

// Map mdast phrasing content to the model's inline nodes. Returns null on the
// first construct the model cannot canonically reproduce from the block alone —
// raw inline HTML and reference-style links/images — telling the caller to freeze
// the containing block verbatim.
function inlineToModel(
  nodes: PhrasingContent[] | undefined,
  marks: InlineMarks,
  ctx: ParseCtx
): InlineNode[] | null {
  if (!nodes) return [];
  const out: InlineNode[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        if (n.value) out.push({ kind: 'text', text: n.value, marks: { ...marks } });
        break;
      case 'inlineCode':
        if (n.value) out.push({ kind: 'text', text: n.value, marks: { ...marks, code: true } });
        break;
      case 'emphasis': {
        const kids = inlineToModel(n.children, { ...marks, em: true }, ctx);
        if (!kids) return null;
        out.push(...kids);
        break;
      }
      case 'strong': {
        const kids = inlineToModel(n.children, { ...marks, strong: true }, ctx);
        if (!kids) return null;
        out.push(...kids);
        break;
      }
      case 'delete': {
        const kids = inlineToModel(n.children, { ...marks, strikethrough: true }, ctx);
        if (!kids) return null;
        out.push(...kids);
        break;
      }
      case 'link': {
        const kids = inlineToModel(n.children, { ...marks, link: { href: n.url ?? '', title: n.title ?? null } }, ctx);
        if (!kids) return null;
        out.push(...kids);
        break;
      }
      case 'image':
        out.push({ kind: 'image', url: n.url ?? '', alt: n.alt ?? '', title: n.title ?? null, marks: { ...marks } });
        break;
      case 'break':
        out.push({ kind: 'break', marks: { ...marks } });
        break;
      case 'html':
        // Raw inline HTML. On the paste path (inlineHtmlAsText) keep it as literal
        // text so the surrounding prose stays an editable paragraph and the tag
        // renders verbatim; otherwise freeze the block (SKR-174 / F27).
        if (ctx.inlineHtmlAsText) {
          if (n.value) out.push({ kind: 'text', text: n.value, marks: { ...marks } });
          break;
        }
        return null;
      default:
        // linkReference, imageReference — freezing beats lossy plain text.
        return null;
    }
  }
  return out;
}

function frozen(src: string, gapBefore: string | null, id: string, durable: boolean): FrozenBlock {
  return { type: 'frozen_block', id, durable, src, gapBefore };
}

// The literal marker/delimiter/fence styles are not on the mdast node, so read
// them back from the source at the node's byte offset (same approach the
// projection parser uses), keeping a dirty list/code block in the writer's own
// style rather than churning it to one canonical form.
function bulletMarker(node: List, md: string): string {
  const off = offsetStart(node, 0);
  return md.slice(off, off + 8).match(/^\s*([-*+])/)?.[1] ?? '-';
}
function orderedDelimiter(node: List, md: string): string {
  const off = offsetStart(node, 0);
  return md.slice(off, off + 16).match(/^\s*\d+([.)])/)?.[1] ?? '.';
}
function fenceOf(node: Code, md: string): string | null {
  const off = offsetStart(node, 0);
  const lineEnd = md.indexOf('\n', off);
  const firstLine = md.slice(off, lineEnd === -1 ? md.length : lineEnd);
  return firstLine.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? null;
}

// A list item's children: an opening paragraph followed by any further blocks.
// Returns null — freezing the whole list — if the item is empty, does not open
// with a paragraph, or holds a child we cannot model.
function mapListItemChildren(item: MdListItem, ctx: ParseCtx): BlockNode[] | null {
  const kids: BlockNode[] = [];
  for (const child of item.children ?? []) {
    const block = childBlockToModel(child, ctx);
    if (!block) return null;
    kids.push(block);
  }
  if (kids.length === 0 || kids[0]?.type !== 'paragraph') return null;
  return kids;
}

function listToModel(node: List, ctx: ParseCtx, base: BlockBaseInit): BlockNode | null {
  const items: ListItem[] = [];
  for (const item of node.children ?? []) {
    const kids = mapListItemChildren(item, ctx);
    if (!kids) return null;
    const li: ListItem = { spread: item.spread === true, children: kids };
    // GFM task-list state: mdast carries `checked: boolean` for task items and
    // null/undefined for plain items — only the boolean is modeled.
    if (typeof item.checked === 'boolean') li.checked = item.checked;
    items.push(li);
  }
  if (items.length === 0) return null;

  const spread = node.spread === true;
  if (node.ordered) {
    return {
      type: 'ordered_list',
      ...base,
      start: node.start ?? 1,
      delimiter: orderedDelimiter(node, ctx.md) === ')' ? ')' : '.',
      spread,
      items
    };
  }
  return { type: 'bullet_list', ...base, marker: bulletMarker(node, ctx.md), spread, items };
}

function tableToModel(node: Table, base: BlockBaseInit, ctx: ParseCtx): BlockNode | null {
  const rowsM = node.children ?? [];
  if (rowsM.length === 0) return null;
  const colCount = (rowsM[0]?.children ?? []).length;
  if (colCount === 0) return null;
  const alignM = node.align ?? [];

  const align: TableAlign[] = [];
  for (let c = 0; c < colCount; c++) align.push((alignM[c] as TableAlign) ?? null);

  const rows: TableCell[][] = [];
  for (const row of rowsM) {
    const cells: TableCell[] = [];
    for (let c = 0; c < colCount; c++) {
      const cell = row?.children?.[c];
      const inline = cell ? inlineToModel(cell.children, {}, ctx) : [];
      if (!inline) return null; // unmappable cell -> freeze the table
      cells.push(inline);
    }
    rows.push(cells);
  }
  return { type: 'table', ...base, align, rows };
}

// Map an mdast block for use INSIDE a modeled container. No per-block source map:
// the container owns the verbatim `src`. Returns null for any construct we cannot
// canonically reproduce, freezing the whole container.
function childBlockToModel(node: RootContent, ctx: ParseCtx): BlockNode | null {
  const base = nestedBase(ctx.genId);
  switch (node.type) {
    case 'paragraph': {
      const inline = inlineToModel(node.children, {}, ctx);
      return inline ? { type: 'paragraph', ...base, inline } : null;
    }
    case 'heading': {
      const inline = inlineToModel(node.children, {}, ctx);
      return inline ? { type: 'heading', ...base, level: node.depth, inline } : null;
    }
    case 'code':
      return {
        type: 'code_block',
        ...base,
        lang: node.lang ?? '',
        meta: node.meta ?? null,
        fence: fenceOf(node, ctx.md),
        text: node.value ?? ''
      };
    case 'thematicBreak':
      return { type: 'horizontal_rule', ...base };
    case 'list':
      return listToModel(node, ctx, base);
    case 'blockquote': {
      const kids = mapChildBlocks(node.children, ctx);
      return kids ? { type: 'blockquote', ...base, children: kids } : null;
    }
    default:
      // Tables nested in a container, raw HTML: freeze the container as a whole.
      return null;
  }
}

function mapChildBlocks(children: RootContent[], ctx: ParseCtx): BlockNode[] | null {
  const out: BlockNode[] = [];
  for (const child of children) {
    const block = childBlockToModel(child, ctx);
    if (!block) return null;
    out.push(block);
  }
  return out.length > 0 ? out : null;
}

// Map a top-level mdast block. Always returns a block (frozen as the safe
// fallback), carrying its source map and durable identity.
function blockToModel(
  node: RootContent,
  src: string,
  gapBefore: string,
  ctx: ParseCtx,
  id: string,
  durable: boolean
): BlockNode {
  const base = topBase(id, durable, src, gapBefore);
  switch (node.type) {
    case 'heading': {
      const inline = inlineToModel(node.children, {}, ctx);
      return inline ? { type: 'heading', ...base, level: node.depth, inline } : frozen(src, gapBefore, id, durable);
    }
    case 'paragraph': {
      const inline = inlineToModel(node.children, {}, ctx);
      return inline ? { type: 'paragraph', ...base, inline } : frozen(src, gapBefore, id, durable);
    }
    case 'code':
      return {
        type: 'code_block',
        ...base,
        lang: node.lang ?? '',
        meta: node.meta ?? null,
        fence: fenceOf(node, ctx.md),
        text: node.value ?? ''
      };
    case 'thematicBreak':
      return { type: 'horizontal_rule', ...base };
    case 'blockquote': {
      const kids = mapChildBlocks(node.children, ctx);
      return kids ? { type: 'blockquote', ...base, children: kids } : frozen(src, gapBefore, id, durable);
    }
    case 'list':
      return listToModel(node, ctx, base) ?? frozen(src, gapBefore, id, durable);
    case 'table':
      return tableToModel(node, base, ctx) ?? frozen(src, gapBefore, id, durable);
    default:
      // HTML, definitions, footnotes, etc.: preserved verbatim, never canonicalized.
      return frozen(src, gapBefore, id, durable);
  }
}

/**
 * Parse Markdown into the canonical block model, capturing the verbatim source
 * map and restoring/assigning block ids. `<!-- sk:ID -->` anchor comments are
 * consumed and bound to the block they precede.
 */
export function parseDocument(source: string, options?: ParseOptions): Document {
  const genId = options?.generateId ?? generateBlockId;
  // The SAME string the parser sees (SKR-160). mdast offsets index the normalized
  // text, and `src` slices index `ctx.md` — hand them different bytes and every
  // slice after the first CRLF is off by the carriage returns before it.
  const md = normalizeLineEndings(source);
  const ctx: ParseCtx = { md, genId, inlineHtmlAsText: options?.inlineHtmlAsText === true };
  const root = parseMarkdown(md);
  const children = root.children ?? [];

  const blocks: BlockNode[] = [];
  let prevEnd = 0;
  // A pending durable anchor consumed from a `<!-- sk:ID -->` comment, waiting to
  // bind to the next block. `commentStart` is where the comment began, so the
  // following block's gap is the seam BEFORE the comment.
  let pending: { id: string; commentStart: number } | null = null;

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const start = offsetStart(child, prevEnd);
    const end = offsetEnd(child, start);

    // An anchor comment: consume it iff a mappable, non-html block follows. The
    // comment's bytes are reconstructed at save, so they belong to neither the
    // seam gap nor the block src.
    if (child.type === 'html' && pending === null) {
      const id = parseAnchorComment((child as { value: string }).value);
      const next = children[i + 1];
      if (id !== null && next && next.type !== 'html') {
        pending = { id, commentStart: start };
        continue; // prevEnd stays at the prior block's end (the real seam start)
      }
    }

    let gapBefore: string;
    let id: string;
    let durable: boolean;
    if (pending !== null) {
      gapBefore = md.slice(prevEnd, pending.commentStart);
      id = pending.id;
      durable = true;
      pending = null;
    } else {
      gapBefore = md.slice(prevEnd, start);
      id = genId();
      durable = false;
    }
    const src = md.slice(start, end);
    blocks.push(blockToModel(child, src, gapBefore, ctx, id, durable));
    prevEnd = end;
  }

  const trailingGap = md.slice(prevEnd);

  // An empty document still needs one block to satisfy the model's "at least one
  // block" shape.
  if (blocks.length === 0) {
    blocks.push({
      type: 'paragraph',
      id: genId(),
      durable: false,
      src: '',
      gapBefore: '',
      dirty: false,
      inline: []
    });
  }

  return { blocks, trailingGap };
}
