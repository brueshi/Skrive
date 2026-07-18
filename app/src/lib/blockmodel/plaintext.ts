// Plain-text serialization of the block model (SKR-126, the "Copy as plain
// text" half of the Copy page button). Distinct from serialize.ts, which emits
// canonical Markdown: this flattens the document to bare prose, dropping the
// Markdown syntax (`#`, `*`, `-`, backticks, link/image punctuation) and keeping
// only the readable text. Pure and substrate-independent like the rest of the
// model — no DOM, no view layer.
//
// Choices: bullet markers are dropped (pure decoration), ordered-list numbers
// are kept (they carry sequence, which is content). Code blocks keep their
// verbatim text. Tables flatten to tab-separated rows. Horizontal rules vanish.
// Hard breaks become newlines. Blocks are separated by a blank line.

import type { BlockNode, Document, InlineNode } from './types';

function inlineToText(nodes: InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text;
    else if (node.kind === 'tag') out += `#${node.name}`;
    else if (node.kind === 'image') out += node.alt;
    else if (node.kind === 'break') out += '\n';
    // A footnote reference is a pointer, not prose — its content lives in the
    // definition (rendered where that block sits), so it flattens to nothing.
    else if (node.kind === 'footnote_ref') out += '';
  }
  return out;
}

// The text of a list item: its child blocks flattened and joined by newlines.
// Most items are a single paragraph; nested content lands as continuation lines.
function itemToText(children: BlockNode[]): string {
  return children.map(blockToText).join('\n');
}

function blockToText(block: BlockNode): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return inlineToText(block.inline);
    case 'code_block':
      return block.text;
    case 'blockquote':
    case 'footnote_definition':
      return block.children.map(blockToText).join('\n\n');
    case 'bullet_list':
      return block.items.map((item) => itemToText(item.children)).join('\n');
    case 'ordered_list': {
      let n = block.start;
      return block.items
        .map((item) => `${n++}. ${itemToText(item.children)}`)
        .join('\n');
    }
    case 'table':
      return block.rows
        .map((row) => row.map((cell) => inlineToText(cell)).join('\t'))
        .join('\n');
    case 'horizontal_rule':
      return '';
    case 'frozen_block':
      return block.src;
  }
}

/** Flatten a document to plain prose with no Markdown syntax. Trailing newline,
 *  blocks separated by a blank line; empty blocks (e.g. rules) are dropped. */
export function documentToPlainText(doc: Document): string {
  const body = doc.blocks
    .map(blockToText)
    .filter((s) => s.length > 0)
    .join('\n\n')
    .trim();
  return body === '' ? '' : `${body}\n`;
}
