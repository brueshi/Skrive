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
//
// ---------------------------------------------------------------------------
// THE CANONICALIZATION CONTRACT (SKR-189 / F17, F18). The rule, stated once:
//
//   The model carries MEANING. Markdown carries meaning plus a dialect. An
//   untouched block keeps its dialect because its bytes are kept. A block the
//   writer actually changed is re-emitted in the house style, because the model
//   never recorded which of Markdown's several spellings the writer had used.
//
// So, on a block that genuinely changed:
//
//   `__bold__`      -> `**bold**`        `_em_`   -> `*em*`
//   `Title\n=====`  -> `# Title`         `a &amp; b` -> `a & b`
//   `* item`        -> `- item`          `1)`     -> `1.` (kind toggles; SKR-181)
//
// None of these change what the document MEANS, and every one of them is
// invisible until an edit lands on that block. Reverting an edit restores the
// original bytes exactly, because the guard compares trees, not strings.
//
// The alternative — a style facet per construct (heading setext-ness, emphasis
// delimiter, entity spelling, bullet char) — was considered and refused. It
// would put presentation into a model whose native format deliberately does not
// persist it: `.folio` stores an ordered list's `start` and not its `delimiter`
// (SKR-181). A facet that survives editing but dies on reload is a worse promise
// than one never made. Style survives where it is free (verbatim `src`), and
// nowhere else.
//
// Freeze granularity (F17) follows from the same idea: a construct the model
// cannot reproduce freezes the WHOLE top-level block, because a block is the
// unit that owns `src`. Finer granularity would need sub-block source maps,
// which is a different design, not a tweak to this one.
//
// Two invariants this file owes the parser, and now defends:
//   - A text run never emits a raw newline (F20). A newline inside a paragraph
//     is block syntax on the way back in — see `collectInline`.
//   - A block emits either a whole block or nothing at all (F19). An empty
//     paragraph has no Markdown form, so it is dropped with its seam gap rather
//     than leaving a stray blank line behind — see `serializeDocument`.
// ---------------------------------------------------------------------------

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
    // Underline is deliberately absent here: it has no Markdown syntax, so it is a
    // `.folio`-native mark and degrades to plain text on this Markdown path (an
    // `<u>` passthrough would freeze the whole block on re-parse, not restore the
    // mark). `.folio` persists it natively via the folio serializer.
    const context = {
      em: m.em === true,
      strong: m.strong === true,
      strikethrough: m.strikethrough === true,
      link: m.link ? { href: m.link.href, title: m.link.title } : null
    };
    let item: InlineItem | null = null;
    if (node.kind === 'tag') {
      // A tag serializes to its literal `#name` body text, so a `.md` file
      // round-trips byte-for-byte and other tools see a plain hashtag. It rides
      // the surrounding mark context and coalesces with adjacent text below.
      item = { ...context, kind: 'text', text: `#${node.name}` };
    } else if (node.kind === 'text') {
      // The serializer defends its own invariant (SKR-189 / F20). A newline is
      // never content in a text run — a line break is a `break` node — but a run
      // carrying one used to be emitted raw, and a raw newline inside a paragraph
      // is BLOCK syntax to the parser on the way back. `"a\n\nb"` reloaded as two
      // paragraphs; `"| a |\n| - |\n| 1 |"` reloaded as a table. That is the
      // canonical-fixpoint violation F14 describes, reached through this door
      // rather than through a missing stringifier extension.
      const text = node.text.replace(/\r?\n/g, ' ');
      if (text) item = { ...context, kind: m.code === true ? 'code' : 'text', text };
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
  // A hard break at the very END of a block has no rendered effect in Markdown and
  // serializes to a bare, dangling `\` (invalid — a hard break must be followed by
  // content) — F15. The block model and the native `.folio` encoding keep trailing
  // breaks faithfully; only the lossy Markdown floor (export + copy-out) drops
  // them, matching what Docs/Notion emit on export.
  while (items.length > 0 && items[items.length - 1]!.kind === 'break') items.pop();
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
  let emitted = 0;
  doc.blocks.forEach((block, index) => {
    const body = serializeBlock(block);
    // A paragraph emptied of text has no Markdown form. It used to emit its seam
    // gap and nothing else, so the file grew a stray blank line and the block
    // vanished on reload — half a block (SKR-189 / F19). Drop it whole: the gap
    // goes with the body. The block still lives in the model, and `.folio` (JSON)
    // keeps it, which is where a blank line the writer typed actually belongs.
    if (body === '') return;
    // Whatever survives to be emitted first opens the file, even if the blocks
    // before it were dropped and captured a seam of their own.
    out += emitted === 0 && index > 0 ? '' : gapForSeam(block, emitted);
    if (block.durable) out += `${formatAnchorComment(block.id)}\n`;
    out += body;
    emitted++;
  });
  out += doc.trailingGap;
  return out;
}
