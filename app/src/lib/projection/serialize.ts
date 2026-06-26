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
//
// The subtle, substrate-independent parts — the idempotence guard
// (semanticallyEqual / mdastEqual) and the CommonMark inline reconstruction — now
// live in ../markdown-core and are shared with the canonical block serializer, so
// the two can never disagree about escaping or what an edit preserved. This file
// keeps only the ProseMirror-specific reads: flattening a PM node's inline
// content into the shared InlineItem currency, and the per-block-type structural
// serialization that reads PM node attrs and children.

import type { Node as PMNode } from 'prosemirror-model';
import {
  type InlineItem,
  inlineItemsToParagraphMarkdown,
  inlineItemsToHeadingMarkdown,
  mdastEqual,
  semanticallyEqual
} from '../markdown-core';

// Re-exported for the dirty-corpus fidelity gate, which imports it from here.
export { mdastEqual };

// Flatten a block's inline content into InlineItem runs, coalescing adjacent text
// with the same context (PM may hold a just-extended bold span as two adjacent
// strong text nodes). In a context that cannot hold a line break (a table cell —
// rows are single lines), a hard break degrades to a single space: the same
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
      prev.em === item.em &&
      prev.strong === item.strong &&
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
  });
  return items;
}

// PM inline content -> canonical Markdown, in paragraph context (line-start block
// openers like `> ` get escaped). Used for paragraphs and table cells.
function canonicalInline(node: PMNode, breaks: 'keep' | 'space'): string {
  return inlineItemsToParagraphMarkdown(collectInline(node, breaks));
}

// A heading serializes as a whole mdast heading so the library owns the heading-
// specific safety rules: a hard break (only reachable from a setext source — ATX
// headings cannot contain one) keeps the heading on one parse by emitting setext
// for depth 1-2 and collapsing to a space for depth 3+ (F5).
function canonicalHeading(block: PMNode): string {
  return inlineItemsToHeadingMarkdown(collectInline(block, 'keep'), Number(block.attrs.level) || 1);
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

// PM table -> canonical GFM: a header row, an alignment delimiter row derived from
// the header cells' `align` attr, then the body rows. Cells serialize their inline
// content through canonicalInline (so marks survive, with hard breaks degraded to
// spaces — a row is a single line) and pipes escaped on top. Minimal padding —
// `| a | b |` — which re-parses to the same table, so this is a fixpoint; an
// untouched table is restored verbatim by the idempotence guard.
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
// document versions, so across debounced snapshots only the block actually edited
// since the last snapshot is a fresh reference and recomputes; every other block —
// clean or dirty — is a cache hit. This bounds a snapshot to the one changed block
// rather than re-running the parse-heavy idempotence guard for every dirty block
// accumulated over a writing session. The WeakMap lets entries for superseded node
// versions be collected on their own.
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

// The gap at the seam before a block. A captured seam (string) is authoritative; a
// new seam (null) is reconstructed: nothing before the first block, the standard
// blank-line separator between top-level blocks otherwise.
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
