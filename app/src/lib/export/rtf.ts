// RTF export: `.folio` -> a minimal, hand-rolled Rich Text Format document.
//
// The one export format with no existing serializer. RTF is a plain-text
// control-word grammar; this writer walks the block model and emits a compact,
// portable document that opens as formatted text in TextEdit, Word, and Pages.
//
// Coverage is deliberate and honest about its edges:
//   - headings           bold + a level-scaled font size (RTF has no semantic
//                         heading; size is the faithful projection)
//   - bold/italic/strike  \b \i \strike toggles
//   - inline code / code  a monospace font run (\f1)
//   - links               a real HYPERLINK field
//   - lists               marker + tab, indented; task items keep [x]/[ ]
//   - blockquote          left-indented paragraphs
//   - horizontal rule     a bottom-border paragraph
//   - tables              FLATTENED to tab-separated rows (RTF's real table model
//                         is out of scope) — lossy-by-design, like plain text
//   - images              alt text only (RTF image embedding is out of scope)
//
// Text is escaped for RTF's structural characters and any non-ASCII is emitted as
// `\uN?` unicode escapes with an ANSI `?` fallback, so the output is valid
// 7-bit-safe RTF.

import type { BlockNode, InlineNode, ListItem, TableBlock } from '../blockmodel/types';
import { folioToModel } from '../folio/convert';
import type { FolioDocument } from '../folio/types';

// Half-point font sizes (RTF `\fsN`). Body is 24 (12pt); headings scale down by
// level; code is slightly smaller.
const BODY_FS = 24;
const CODE_FS = 20;
const HEADING_FS: Record<number, number> = { 1: 36, 2: 32, 3: 28, 4: 26, 5: 24, 6: 24 };

// Twips (1/20 pt). The hanging-indent width for list markers and the extra
// indent a blockquote adds.
const LIST_INDENT = 720;
const HANG = 360;
const QUOTE_INDENT = 480;

/** Escape a run of text for RTF: structural chars, tabs/newlines as control
 *  words, and any non-ASCII code unit as a `\uN?` unicode escape. */
function escapeText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '\\{';
    else if (ch === '}') out += '\\}';
    else if (ch === '\n') out += '\\line ';
    else if (ch === '\t') out += '\\tab ';
    else if (code < 128) out += ch;
    else if (code > 0xffff) {
      // Astral plane: emit the UTF-16 surrogate pair as two \u code units.
      const c = code - 0x10000;
      out += `\\u${0xd800 + (c >> 10)}?\\u${0xdc00 + (c & 0x3ff)}?`;
    } else {
      // RTF wants a signed 16-bit value; wrap the upper half to negative.
      out += `\\u${code > 32767 ? code - 65536 : code}?`;
    }
  }
  return out;
}

/** A run of inline nodes with their mark toggles applied. */
function renderInline(nodes: InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'break') {
      out += '\\line ';
      continue;
    }
    if (node.kind === 'image') {
      out += escapeText(node.alt);
      continue;
    }
    if (node.kind === 'footnote_ref') {
      // A superscript label; RTF footnote objects are out of scope, matching the
      // lossy-but-honest posture the rest of this exporter takes.
      out += `\\super ${escapeText(node.label)}\\nosupersub `;
      continue;
    }
    const m = node.marks;
    let open = '';
    let close = '';
    if (m.strong) {
      open += '\\b ';
      close = '\\b0 ' + close;
    }
    if (m.em) {
      open += '\\i ';
      close = '\\i0 ' + close;
    }
    if (m.strikethrough) {
      open += '\\strike ';
      close = '\\strike0 ' + close;
    }
    if (m.code) {
      open += '\\f1 ';
      close = '\\f0 ' + close;
    }
    const text = node.kind === 'tag' ? `#${node.name}` : node.text;
    const run = open + escapeText(text) + close;
    if (m.link) {
      out += `{\\field{\\*\\fldinst HYPERLINK "${escapeText(m.link.href)}"}{\\fldrslt \\ul ${run}\\ul0 }}`;
    } else {
      out += run;
    }
  }
  return out;
}

/** The `[x] ` / `[ ] ` prefix for a task-list item, or empty for a plain item. */
function checkboxPrefix(item: ListItem): string {
  if (item.checked === true) return '[x] ';
  if (item.checked === false) return '[ ] ';
  return '';
}

function renderList(
  items: ListItem[],
  indent: number,
  marker: (item: ListItem) => string
): string {
  const contentIndent = indent + LIST_INDENT;
  let out = '';
  for (const item of items) {
    const [first, ...rest] = item.children;
    const label = `${marker(item)}${checkboxPrefix(item)}`;
    if (first && first.type === 'paragraph') {
      out += `\\pard\\fi-${HANG}\\li${contentIndent}\\sa60\\fs${BODY_FS} ${label}${renderInline(first.inline)}\\par\n`;
      for (const child of rest) out += renderBlock(child, contentIndent);
    } else {
      // First child isn't a simple paragraph (e.g. a nested list): emit a bare
      // marker line, then the children indented beneath it.
      out += `\\pard\\fi-${HANG}\\li${contentIndent}\\sa60\\fs${BODY_FS} ${label}\\par\n`;
      for (const child of item.children) out += renderBlock(child, contentIndent);
    }
  }
  return out;
}

/** Tables flatten to tab-separated rows — RTF's native table model is out of
 *  scope. Honest and lossy, consistent with the plain-text export. */
function renderTable(table: TableBlock, li: string): string {
  const rows = table.rows.map((row) => row.map((cell) => renderInline(cell)).join('\\tab '));
  return `\\pard${li}\\sa180\\fs${BODY_FS} ${rows.join('\\line ')}\\par\n`;
}

function renderBlock(block: BlockNode, indent: number): string {
  const li = indent > 0 ? `\\li${indent}` : '';
  switch (block.type) {
    case 'heading': {
      const fs = HEADING_FS[block.level] ?? BODY_FS;
      return `\\pard${li}\\sb120\\sa120\\b\\fs${fs} ${renderInline(block.inline)}\\b0\\fs${BODY_FS}\\par\n`;
    }
    case 'paragraph':
      return `\\pard${li}\\sa180\\fs${BODY_FS} ${renderInline(block.inline)}\\par\n`;
    case 'code_block': {
      // Drop a single trailing newline so the block doesn't end on a blank line;
      // remaining newlines become \line via escapeText.
      const text = escapeText(block.text.replace(/\n$/, ''));
      return `\\pard${li}\\sa180\\f1\\fs${CODE_FS} ${text}\\f0\\fs${BODY_FS}\\par\n`;
    }
    case 'horizontal_rule':
      return `\\pard${li}\\brdrb\\brdrs\\brdrw10\\brsp20 \\par\n`;
    case 'blockquote':
      return block.children.map((child) => renderBlock(child, indent + QUOTE_INDENT)).join('');
    case 'footnote_definition': {
      // A label line, then the definition body, so the reader can match it to the
      // superscript ref. A proper RTF footnote object is out of scope.
      const label = `\\pard${li}\\sa60\\b\\fs${BODY_FS} [${escapeText(block.label)}]\\b0\\par\n`;
      const body = block.children.map((child) => renderBlock(child, indent + QUOTE_INDENT)).join('');
      return label + body;
    }
    case 'bullet_list':
      return renderList(block.items, indent, () => '\\bullet\\tab ');
    case 'ordered_list': {
      let n = block.start;
      return renderList(block.items, indent, () => `${n++}.\\tab `);
    }
    case 'table':
      return renderTable(block, li);
    case 'frozen_block':
      // Unreachable from a `.folio` source (folioToModel produces no frozen
      // blocks); handled for exhaustiveness.
      return `\\pard${li}\\sa180\\fs${BODY_FS} ${escapeText(block.src)}\\par\n`;
  }
}

/** Export a `.folio` document to a minimal RTF document. */
export function folioToRtf(folio: FolioDocument): string {
  const doc = folioToModel(folio);
  const body = doc.blocks.map((block) => renderBlock(block, 0)).join('');
  return (
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1\n' +
    '{\\fonttbl{\\f0\\fswiss Helvetica;}{\\f1\\fmodern Courier New;}}\n' +
    `\\fs${BODY_FS}\n` +
    body +
    '}'
  );
}
