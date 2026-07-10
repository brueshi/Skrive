// @vitest-environment jsdom
//
// Bidi contract of the rendered DOM (SKR-232): every block element resolves its
// own direction via dir="auto" — per-paragraph direction, the Docs/Word model —
// with two deliberate exceptions: the table ELEMENT stays direction-neutral
// (direction on a table reorders its columns; its cells resolve individually),
// and list ITEMS carry their own dir so one RTL item in an LTR list puts its
// marker on the correct side. The visual half (quote rule / list padding
// flipping sides) lives in BlockEditor.css as logical properties, which jsdom
// does not lay out — the shell sitting verifies that half.

import { describe, it, expect } from 'vitest';
import { renderBlock } from '../../src/lib/blocksurface/render';
import { parseDocument } from '../../src/lib/blockmodel';

function renderFirst(markdown: string): HTMLElement {
  const doc = parseDocument(markdown);
  expect(doc.blocks.length).toBeGreaterThan(0);
  return renderBlock(doc.blocks[0]!);
}

describe('dir="auto" on rendered blocks', () => {
  it('paragraphs and headings resolve their own direction', () => {
    expect(renderFirst('plain text\n').getAttribute('dir')).toBe('auto');
    expect(renderFirst('# heading\n').getAttribute('dir')).toBe('auto');
  });

  it('code blocks and blockquotes resolve their own direction', () => {
    expect(renderFirst('```\ncode\n```\n').getAttribute('dir')).toBe('auto');
    expect(renderFirst('> quoted\n').getAttribute('dir')).toBe('auto');
  });

  it('lists resolve per item as well as per list', () => {
    const ul = renderFirst('- one\n- two\n');
    expect(ul.getAttribute('dir')).toBe('auto');
    const items = ul.querySelectorAll('li');
    expect(items.length).toBe(2);
    for (const li of items) expect(li.getAttribute('dir')).toBe('auto');
  });

  it('the table element stays neutral while its cells resolve individually', () => {
    const table = renderFirst('| a | b |\n| --- | --- |\n| c | d |\n');
    expect(table.tagName).toBe('TABLE');
    expect(table.getAttribute('dir')).toBeNull();
    const cells = table.querySelectorAll('th, td');
    expect(cells.length).toBe(4);
    for (const cell of cells) expect(cell.getAttribute('dir')).toBe('auto');
  });
});
