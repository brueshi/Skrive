// @vitest-environment jsdom
//
// Selections touching barriers (SKR-166 / F54 + F55). A selection whose endpoint
// sits inside a code block / table used to eat the gesture (silent no-op) or, for
// ⌘A, degrade to a collapsed caret. These pin the fixed behaviour end to end: the
// barrier survives while the prose around it is deleted, a rectangle of cells (the
// grid selection, which a native range across cells becomes) clears the covered
// cells, and readSelection resolves a container-level boundary instead of
// collapsing. jsdom models enough Selection/Range for the
// surface's cellTarget / leafTarget / readSelection to run against a real DOM.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { readSelection } from '../../src/lib/blocksurface/selection';
import { isCollapsed } from '../../src/lib/blocksurface/doc-position';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';
const plain = (inline: InlineNode[]): string => inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  sel.addRange(range);
}
function backspace(surface: BlockSurface): void {
  (surface as unknown as { applyDeleteBackward: () => void }).applyDeleteBackward();
}
function typeText(surface: BlockSurface, text: string): void {
  (surface as unknown as { applyInsertText: (t: string) => void }).applyInsertText(text);
}
function blockOf(surface: BlockSurface, pred: (b: BlockNode) => boolean): BlockNode | undefined {
  return surface.getDocument().blocks.find(pred);
}
function tableBlock(surface: BlockSurface): Extract<BlockNode, { type: 'table' }> {
  const t = blockOf(surface, (b) => b.type === 'table');
  if (!t || t.type !== 'table') throw new Error('no table');
  return t;
}
function paragraphText(surface: BlockSurface): string {
  const p = blockOf(surface, (b) => b.type === 'paragraph');
  return p && p.type === 'paragraph' ? plain(p.inline) : '';
}

describe('readSelection — container-level boundary (F54)', () => {
  it('resolves a select-all end on the container instead of collapsing', () => {
    new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const para = container.querySelector('p')!;
    // ⌘A shape: start in the first block's text, end at the container's edge.
    select(para.firstChild!, 0, container, container.childNodes.length);

    const range = readSelection(container);
    expect(range, 'selection resolved').not.toBeNull();
    expect(isCollapsed(range!), 'did not degrade to a caret').toBe(false);
    // The end resolves to the trailing table (a barrier leaf), not nothing.
    expect(range!.focus.leaf.kind).toBe('block');
    const tableId = container.querySelector('table')!.getAttribute('data-block-id');
    expect(range!.focus.leaf.kind === 'block' ? range!.focus.leaf.id : null).toBe(tableId);
  });
});

describe('Backspace over a barrier-crossing selection (F54)', () => {
  it('select-all + Backspace on a doc ending in a table deletes the prose, keeps the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const para = container.querySelector('p')!;
    select(para.firstChild!, 0, container, container.childNodes.length);

    backspace(surface);

    expect(tableBlock(surface), 'table survives').toBeTruthy();
    expect(paragraphText(surface), 'prose deleted').toBe('');
  });

  it('dragging prose into a table + Backspace deletes prose up to the edge, keeps the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const para = container.querySelector('p')!;
    const headerCell = container.querySelector('[data-cell-row="0"][data-cell-col="0"]')!;
    // Drag from mid-paragraph ("he|llo") into the first table cell.
    select(para.firstChild!, 2, headerCell.firstChild!, 0);

    backspace(surface);

    expect(paragraphText(surface), 'prose deleted up to the table edge').toBe('he');
    expect(tableBlock(surface), 'table survives').toBeTruthy();
    // The header cell content is untouched (the barrier was not cut).
    expect(plain(tableBlock(surface).rows[0]![0]!)).toBe('a');
  });
});

describe('A rectangle of cells (the grid selection)', () => {
  function key(surface: BlockSurface, init: KeyboardEventInit): void {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
  }

  it('Backspace across two cells clears their contents and keeps the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableBlock(surface).id, { row: 1, col: 0 }, { row: 1, col: 1 });

    key(surface, { key: 'Backspace' });

    const table = tableBlock(surface);
    expect(table.rows[1]!.map(plain), 'covered cells cleared').toEqual(['', '']);
    expect(table.rows[0]!.map(plain), 'header row untouched').toEqual(['a', 'b']);
    expect(table.rows.length, 'shape unchanged').toBe(2);
  });

  it('typing across two cells replaces them into the anchor cell, table survives', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableBlock(surface).id, { row: 1, col: 0 }, { row: 1, col: 1 });

    key(surface, { key: 'Z' });

    const table = tableBlock(surface);
    expect(plain(table.rows[1]![0]!)).toBe('Z');
    expect(plain(table.rows[1]![1]!)).toBe('');
    expect(table.rows.length).toBe(2);
  });

  it('a native range across two cells is not a text selection: the prose paths see no range to act on', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const c0 = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')!;
    const c1 = container.querySelector('[data-cell-row="1"][data-cell-col="1"]')!;
    select(c0.firstChild!, 0, c1.firstChild!, c1.textContent!.length);

    // Before the selection observer converts it (a frame later) the range is
    // transient; the delete path declines rather than acting on half a shape.
    backspace(surface);
    typeText(surface, 'Z');

    const table = tableBlock(surface);
    expect(table.rows[1]!.map(plain), 'untouched').toEqual(['1', '2']);
  });
});
