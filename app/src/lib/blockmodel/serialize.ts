// Block model -> Markdown (SKR-96). The save-time serialization, now running FROM
// the canonical block model under the inversion. Same bet as the projection
// serializer, same idempotence guard, same gap-at-seam fidelity — this file reads
// the pure block model instead of a ProseMirror node, and emits the durable
// anchor comment for attachment-bearing blocks. The subtle CommonMark and
// semantic-equality logic is the shared ../markdown-core, so the two serializers
// agree by construction.
//
//   - A clean block emits its verbatim `src` — byte-identical.
//   - A frozen block always emits its verbatim `src`.
//   - A dirty block serializes canonically, unless the idempotence guard finds
//     its canonical form re-parses to the same tree as `src` (an edit reverted),
//     restoring the original bytes.
//   - Gaps reconstruct at the seam: captured (string) verbatim, new (null) the
//     canonical separator.
//   - A durable block carries its `<!-- sk:ID -->` comment immediately before it.

import {
  type InlineItem,
  inlineItemsToParagraphMarkdown,
  inlineItemsToHeadingMarkdown,
  semanticallyEqual
} from '../markdown-core';
import { formatAnchorComment } from './anchor';
import type {
  BlockNode,
  BlockquoteBlock,
  BulletListBlock,
  CodeBlock,
  Document,
  HeadingBlock,
  InlineNode,
  OrderedListBlock,
  TableBlock
} from './types';

// Flatten the model's inline content into InlineItem runs, coalescing adjacent
// text/code with the same mark context. In a single-line context (a table cell), a
// hard break degrades to a space. Mirrors the projection serializer's
// collectInline, reading the block model's inline array instead of PM children.
function collectInline(nodes: InlineNode[], breaks: 'keep' | 'space'): InlineItem[] {
  const items: InlineItem[] = [];
  for (const node of nodes) {
    const m = node.marks;
    const context = {
      em: m.em === true,
      strong: m.strong === true,
      strikethrough: m.strikethrough === true,
      link: m.link ? { href: m.link.href, title: m.link.title } : null
    };
    let item: InlineItem | null = null;
    if (node.kind === 'text') {
      if (node.text) item = { ...context, kind: m.code === true ? 'code' : 'text', text: node.text };
    } else if (node.kind === 'image') {
      item = { ...context, kind: 'image', url: node.url, alt: node.alt, title: node.title };
    } else {
      item = breaks === 'space' ? { ...context, kind: 'text', text: ' ' } : { ...context, kind: 'break' };
    }
    if (!item) continue;
    const prev = items[items.length - 1];
    if (
      prev &&
      prev.kind === item.kind &&
      (item.kind === 'text' || item.kind === 'code') &&
      (prev.kind === 'text' || prev.kind === 'code') &&
      prev.em === item.em &&
      prev.strong === item.strong &&
      prev.strikethrough === item.strikethrough &&
      ((prev.link === null && item.link === null) ||
        (prev.link !== null &&
          item.link !== null &&
          prev.link.href === item.link.href &&
          prev.link.title === item.link.title))
    ) {
      prev.text += item.text;
    } else {
      items.push(item);
    }
  }
  return items;
}

function canonicalInline(nodes: InlineNode[], breaks: 'keep' | 'space'): string {
  return inlineItemsToParagraphMarkdown(collectInline(nodes, breaks));
}

function canonicalHeading(block: HeadingBlock): string {
  return inlineItemsToHeadingMarkdown(collectInline(block.inline, 'keep'), block.level);
}

// F4: reproduce the source fence (``` vs ~~~ and its length), kept LONGER than any
// same-character run in the body so a body line of fence chars can't close it
// early. A fresh/indented block gets backticks, switching to tildes when the info
// string contains a backtick.
function canonicalCodeBlock(block: CodeBlock): string {
  const body = block.text;
  const lang = block.lang ? block.lang : '';
  const meta = block.meta ? block.meta : '';
  const info = meta ? `${lang} ${meta}` : lang;
  const captured = block.fence;
  const ch = captured !== null && captured.startsWith('~') ? '~' : info.includes('`') ? '~' : '`';
  const runs = body.match(ch === '`' ? /`+/g : /~+/g);
  let longest = 0;
  if (runs) for (const r of runs) longest = Math.max(longest, r.length);
  const capturedLen = captured !== null && captured.startsWith(ch) ? captured.length : 0;
  const fence = ch.repeat(Math.max(3, capturedLen, longest + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}

// A list serializes item by item: each item opens with its marker prefix; every
// continuation line is indented to the marker's width. A loose list blank-line-
// separates items; blocks within an item follow the item's own spread.
function serializeList(block: BulletListBlock | OrderedListBlock): string {
  const ordered = block.type === 'ordered_list';
  const spread = block.spread === true;
  const marker = block.type === 'bullet_list' ? block.marker || '-' : '-';
  const start = block.type === 'ordered_list' ? block.start : 1;
  const delimiter = block.type === 'ordered_list' && block.delimiter === ')' ? ')' : '.';

  const rendered = block.items.map((item, index) => {
    const markerPrefix = ordered ? `${start + index}${delimiter} ` : `${marker} `;
    // A GFM task checkbox is item CONTENT, not marker structure: continuation
    // lines indent to the marker width only, or a nested block at checkbox
    // depth would re-parse as indented code.
    const checkbox = typeof item.checked === 'boolean' ? `[${item.checked ? 'x' : ' '}] ` : '';
    const prefix = markerPrefix + checkbox;
    const indent = ' '.repeat(markerPrefix.length);
    const body = item.children.map((child) => canonicalBlock(child)).join(item.spread === true ? '\n\n' : '\n');
    return body
      .split('\n')
      .map((line, i) => {
        if (i === 0) return prefix + line; // the opening paragraph carries the marker
        return line.length > 0 ? indent + line : ''; // continuation, blanks stay blank
      })
      .join('\n');
  });

  return rendered.join(spread ? '\n\n' : '\n');
}

// A blockquote canonically serializes its child blocks, joins with a blank line,
// then quotes every line: `> ` before content, a bare `>` for blank separators.
function quotedBlockquote(block: BlockquoteBlock): string {
  return block.children
    .map((child) => canonicalBlock(child))
    .join('\n\n')
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

// A pipe inside a GFM cell must be escaped, and a cell is a single line — collapse
// any stray newline from a hard break.
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Model table -> canonical GFM: header row, an alignment delimiter row from the
// column `align`, then body rows. Cells serialize inline through canonicalInline
// (hard breaks degraded to spaces) with pipes escaped. Minimal padding, a fixpoint
// the idempotence guard restores verbatim when untouched.
function serializeTable(block: TableBlock): string {
  const rows = block.rows;
  const header = rows[0];
  if (!header) return '';

  const rowLine = (cells: InlineNode[][]): string =>
    `| ${cells.map((cell) => escapeTableCell(canonicalInline(cell, 'space'))).join(' | ')} |`;

  const delimiters = block.align.map((align) =>
    align === 'left' ? ':---' : align === 'right' ? '---:' : align === 'center' ? ':---:' : '---'
  );

  const lines = [rowLine(header), `| ${delimiters.join(' | ')} |`];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row) lines.push(rowLine(row));
  }
  return lines.join('\n');
}

// Canonical serialization of a block by its type. Used for top-level dirty blocks
// (via serializeBlock) and recursively for the children of modeled containers
// (which carry no per-block source map of their own).
function canonicalBlock(block: BlockNode): string {
  switch (block.type) {
    case 'frozen_block':
      return block.src;
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
      // Canonical form for a fresh rule; a parsed rule with a different marker is
      // dirty-equal to this under the idempotence guard, restoring its bytes.
      return '---';
    case 'paragraph':
    default:
      return canonicalInline(block.inline, 'keep');
  }
}

// Memoize by block identity. The block model shares unchanged block objects across
// snapshots (an edit replaces only the touched block), so this bounds a snapshot's
// parse-heavy idempotence work to the one changed block.
const blockCache = new WeakMap<BlockNode, string>();

function serializeBlock(block: BlockNode): string {
  const cached = blockCache.get(block);
  if (cached !== undefined) return cached;
  const result = serializeBlockUncached(block);
  blockCache.set(block, result);
  return result;
}

function serializeBlockUncached(block: BlockNode): string {
  // Frozen blocks are verbatim by construction and carry no `dirty` state.
  if (block.type === 'frozen_block') return block.src;

  const src = block.src;
  if (!block.dirty && src != null) return src;

  const canonical = canonicalBlock(block);
  if (src != null && semanticallyEqual(canonical, src)) return src;
  return canonical;
}

// The gap at the seam before a block. A captured seam (string) is authoritative; a
// new seam (null) reconstructs: nothing before the first block, the standard
// blank-line separator otherwise.
function gapForSeam(block: BlockNode, index: number): string {
  const captured = block.gapBefore;
  if (captured != null) return captured;
  return index === 0 ? '' : '\n\n';
}

/**
 * Serialize a document to Markdown. Durable (attachment-bearing) blocks carry
 * their `<!-- sk:ID -->` comment immediately before the block body, after the
 * seam gap; every other block is byte-pristine.
 */
export function serializeDocument(doc: Document): string {
  let out = '';
  doc.blocks.forEach((block, index) => {
    out += gapForSeam(block, index);
    if (block.durable) out += `${formatAnchorComment(block.id)}\n`;
    out += serializeBlock(block);
  });
  out += doc.trailingGap;
  return out;
}
