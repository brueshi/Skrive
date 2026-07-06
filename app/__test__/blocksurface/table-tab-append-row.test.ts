// @vitest-environment jsdom
//
// Tab in a table's last cell appends a row (SKR-225). Tables were created as a
// fixed 2x2 with no structure editing anywhere: Tab off the last cell fell
// through to exitBarrier and left the table entirely. This is the minimal
// Docs/Word muscle-memory slice: forward Tab in the LAST cell appends one empty
// row (same column count) and steps the caret into its first cell, as a single
// undoable structural op. Shift+Tab at the first cell is UNCHANGED (still exits
// the table backward via exitBarrier) — ArrowDown/ArrowRight already own the
// forward exit gesture (SKR-152), so removing Tab's forward exit doesn't reopen
// a trap. Column ops, row deletion, and a creation-size choice are explicitly
// out of scope (deferred to v1.10).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';
const plain = (inline: InlineNode[]): string => inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');

function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}
function selectRange(sn: Node, so: number, en: Node, eo: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo);
  sel.addRange(range);
}
function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
  return e;
}
function tableBlock(surface: BlockSurface): Extract<BlockNode, { type: 'table' }> {
  const t = surface.getDocument().blocks.find((b) => b.type === 'table');
  if (!t || t.type !== 'table') throw new Error('no table');
  return t;
}
function cellTargetOf(
  surface: BlockSurface
): { tableId: string; row: number; col: number } | null {
  return (surface as unknown as { cellTarget(): { tableId: string; row: number; col: number } | null }).cellTarget();
}
function leafTargetOf(surface: BlockSurface): { leaf: BlockNode; start: number } | null {
  return (surface as unknown as { leafTarget(): { leaf: BlockNode; start: number } | null }).leafTarget();
}
function cell(row: number, col: number): HTMLElement {
  return container.querySelector(`[data-cell-row="${row}"][data-cell-col="${col}"]`)!;
}

describe('Tab in the last table cell appends a row (SKR-225)', () => {
  it('appends an empty row of the same width and moves the caret into its first cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const last = cell(1, 1);
    caretIn(last.firstChild!, last.textContent!.length);

    const e = key(surface, { key: 'Tab' });

    expect(e.defaultPrevented, 'Tab is consumed, not a native focus escape').toBe(true);
    const table = tableBlock(surface);
    expect(table.rows.length, 'a row was appended').toBe(3);
    expect(table.rows[2]!.map(plain), 'the new row is empty and matches the column count').toEqual(['', '']);
    // Original rows are untouched.
    expect(table.rows[0]!.map(plain)).toEqual(['a', 'b']);
    expect(table.rows[1]!.map(plain)).toEqual(['1', '2']);

    const target = cellTargetOf(surface);
    expect(target?.tableId).toBe(table.id);
    expect(target?.row, 'caret lands in the new row').toBe(2);
    expect(target?.col, 'caret lands in the first cell').toBe(0);
  });

  it('one undo removes the appended row and restores the caret to the last cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const last = cell(1, 1);
    caretIn(last.firstChild!, last.textContent!.length);

    key(surface, { key: 'Tab' });
    expect(tableBlock(surface).rows.length).toBe(3);

    surface.undo();

    const table = tableBlock(surface);
    expect(table.rows.length, 'the appended row is gone').toBe(2);
    expect(table.rows.map((r) => r.map(plain))).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
    const target = cellTargetOf(surface);
    expect(target?.row, 'caret restored to the cell Tab was pressed in').toBe(1);
    expect(target?.col).toBe(1);
  });
});

describe('Tab in a non-last cell still moves to the next cell (SKR-225 regression guard)', () => {
  it('steps from the header first cell to the header second cell, no structural change', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const first = cell(0, 0);
    caretIn(first.firstChild!, 0);

    const e = key(surface, { key: 'Tab' });

    expect(e.defaultPrevented).toBe(true);
    expect(tableBlock(surface).rows.length, 'shape unchanged').toBe(2);
    const target = cellTargetOf(surface);
    expect(target?.row).toBe(0);
    expect(target?.col).toBe(1);
  });
});

describe('Shift+Tab at the first cell keeps current behavior (locked, SKR-225)', () => {
  it('exits the table backward into the preceding paragraph, table untouched', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const first = cell(0, 0);
    caretIn(first.firstChild!, 0);

    const e = key(surface, { key: 'Tab', shiftKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(tableBlock(surface).rows.length, 'no structural change').toBe(2);
    const t = leafTargetOf(surface);
    expect(t?.leaf.type, 'caret exited to the preceding paragraph').toBe('paragraph');
    expect(t?.start).toBe('hello'.length);
  });
});

describe('Tab with a multi-item list selection is untouched (SKR-169)', () => {
  it('still indents every selected item together, unaffected by the table Tab change', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('- a\n- b\n- c\n') });
    const items = container.querySelectorAll('li p');
    selectRange(items[1]!.firstChild!, 0, items[2]!.firstChild!, 1);

    const e = key(surface, { key: 'Tab' });

    expect(e.defaultPrevented, 'Tab must be consumed, not a native focus escape').toBe(true);
    type List = Extract<BlockNode, { type: 'bullet_list' | 'ordered_list' }>;
    type Para = Extract<BlockNode, { type: 'paragraph' }>;
    const list = surface.getDocument().blocks[0] as List;
    expect(list.items).toHaveLength(1);
    const sub = list.items[0]!.children.find((c) => c.type === 'bullet_list') as List | undefined;
    expect(sub).toBeDefined();
    expect(sub!.items.map((it) => plain((it.children[0] as Para).inline))).toEqual(['b', 'c']);
  });
});
