// @vitest-environment jsdom
//
// The grid selection: one primitive, a cell rectangle addressed to its table. A
// handle click selects a row or column as a rectangle spanning the grid; a drag,
// Shift+click, and Shift+Arrow build any rectangle; Cmd+A climbs text, cell,
// table, document; Escape steps back down to a caret. Backspace and Delete clear
// the covered cells, and only Cmd+Backspace removes structure, and only what the
// rectangle covers in full. The state is authoritative surface state (not a DOM
// selection, which a handle click never leaves and WKWebView would collapse), so
// these drive the real keydown routing; the chrome paints it (see
// table-chrome-interaction.test.ts). jsdom models enough DOM for the cell queries,
// focusCell, and readSelection to run.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../jsdom-range-rect';
import { BlockSurface, type TableMenuState } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

// A 3-column, 3-row table (header + two body rows).
const TABLE = '| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';
const at = (row: number, col: number) => ({ row, col });
const cells = (anchor: [number, number], focus: [number, number]) => ({
  kind: 'cells' as const,
  anchor: at(...anchor),
  focus: at(...focus)
});

function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
  return e;
}
function tableBlock(surface: BlockSurface): Extract<BlockNode, { type: 'table' }> {
  const b = surface.getDocument().blocks.find((x) => x.type === 'table');
  if (!b || b.type !== 'table') throw new Error('no table');
  return b;
}
function tableId(surface: BlockSurface): string {
  return tableBlock(surface).id;
}
/** The text of each cell, row-major, for asserting shape after a structural op. */
function grid(surface: BlockSurface): string[][] {
  return tableBlock(surface).rows.map((row) =>
    row.map((cell) => cell.map((n) => (n.kind === 'text' ? n.text : '')).join(''))
  );
}
function cellEl(row: number, col: number): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-cell-row="${row}"][data-cell-col="${col}"]`);
  if (!el) throw new Error(`no cell ${row},${col}`);
  return el;
}
function caretIn(row: number, col: number, offset = 0): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const r = document.createRange();
  const el = cellEl(row, col);
  r.setStart(el.firstChild ?? el, offset);
  r.collapse(true);
  sel.addRange(r);
}
/** Where the live caret sits, as a cell coordinate, or null. */
function caretCell(): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>('[data-cell-row]');
  return el ? [Number(el.dataset.cellRow), Number(el.dataset.cellCol)] : null;
}
function selectionOf(surface: BlockSurface) {
  return surface.getTableSelection()?.selection ?? null;
}

describe('a handle click selects a slice as a rectangle spanning the grid', () => {
  it('a column is the rectangle from the header to the last row', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 1);
    expect(surface.getTableSelection()).toEqual({ tableId: tableId(surface), selection: cells([0, 1], [2, 1]) });
    // The caret is parked, collapsed, in the home cell (the rectangle's anchor)
    // while the grid selection holds; the stylesheet hides it.
    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(caretCell()).toEqual([0, 1]);
    expect(container.classList.contains('sk-grid-selected')).toBe(true);
  });

  it('a row is the rectangle across every column', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableRow(tableId(surface), 2);
    expect(selectionOf(surface)).toEqual(cells([2, 0], [2, 2]));
  });
});

describe('Backspace and Delete clear; only Cmd+Backspace removes structure', () => {
  it('Backspace on a column clears its cells and keeps the shape', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 1);

    const e = key(surface, { key: 'Backspace' });

    expect(e.defaultPrevented).toBe(true);
    expect(grid(surface)).toEqual([
      ['a', '', 'c'],
      ['1', '', '3'],
      ['4', '', '6']
    ]);
    expect(surface.getTableSelection()).toBeNull();
    expect(caretCell(), 'the caret lands in the anchor').toEqual([0, 1]);
  });

  it('Delete on a rectangle clears just the covered cells', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableId(surface), at(1, 1), at(2, 2));
    key(surface, { key: 'Delete' });
    expect(grid(surface)).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
      ['4', '', '']
    ]);
    expect(caretCell()).toEqual([1, 1]);
  });

  it('Cmd+Backspace on a column removes it, align tracking the header width', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 1);

    const e = key(surface, { key: 'Backspace', metaKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(grid(surface)).toEqual([
      ['a', 'c'],
      ['1', '3'],
      ['4', '6']
    ]);
    expect(tableBlock(surface).align).toHaveLength(2);
    expect(surface.getTableSelection()).toBeNull();
  });

  it('Cmd+Delete on two rows removes both as one undo step', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableId(surface), at(1, 0), at(2, 2));
    key(surface, { key: 'Delete', ctrlKey: true });
    expect(grid(surface)).toEqual([['a', 'b', 'c']]);
    surface.undo();
    expect(grid(surface)).toHaveLength(3);
  });

  it('Cmd+Backspace on a partial rectangle has no structure to remove, so it clears', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableId(surface), at(1, 1), at(1, 2));
    key(surface, { key: 'Backspace', metaKey: true });
    expect(grid(surface)).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
      ['4', '5', '6']
    ]);
  });

  it('removing the header row promotes the next row to header', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableRow(tableId(surface), 0);
    key(surface, { key: 'Backspace', metaKey: true });
    expect(grid(surface)[0]).toEqual(['1', '2', '3']);
  });

  it('a rectangle covering the whole table removes the table under Cmd+Backspace', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableId(surface), at(0, 0), at(2, 2));
    key(surface, { key: 'Backspace', metaKey: true });
    expect(surface.getDocument().blocks.some((b) => b.type === 'table')).toBe(false);
  });

  it('removing the only column removes the whole table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('| a |\n| - |\n| 1 |\n') });
    surface.selectTableColumn(tableId(surface), 0);
    key(surface, { key: 'Delete', metaKey: true });
    expect(surface.getDocument().blocks.some((b) => b.type === 'table')).toBe(false);
  });
});

describe('extending the rectangle', () => {
  it('Shift+Arrow moves the focus and keeps the anchor, clamped to the grid', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableId(surface), at(1, 1), at(1, 1));

    const e = key(surface, { key: 'ArrowRight', shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(selectionOf(surface)).toEqual(cells([1, 1], [1, 2]));

    key(surface, { key: 'ArrowDown', shiftKey: true });
    expect(selectionOf(surface)).toEqual(cells([1, 1], [2, 2]));

    key(surface, { key: 'ArrowDown', shiftKey: true }); // already at the last row
    expect(selectionOf(surface)).toEqual(cells([1, 1], [2, 2]));
  });

  it('Shift+ArrowRight with the caret at the end of its cell starts a rectangle', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    caretIn(1, 0, 1); // after "1"

    const e = key(surface, { key: 'ArrowRight', shiftKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(selectionOf(surface)).toEqual(cells([1, 0], [1, 1]));
    expect(window.getSelection()?.isCollapsed, 'no text highlight runs across cells').toBe(true);
    expect(caretCell(), 'the caret stays parked where it was').toEqual([1, 0]);
  });

  it('Shift+ArrowLeft mid-text is left to the native text extension', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    caretIn(1, 1, 1); // after "2": the left edge is not here
    const e = key(surface, { key: 'ArrowLeft', shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(surface.getTableSelection()).toBeNull();
  });

  it('Shift+ArrowRight at the grid edge is left to the native step out of the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n\nafter\n`) });
    caretIn(2, 2, 1); // the last cell's end
    const e = key(surface, { key: 'ArrowRight', shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(surface.getTableSelection()).toBeNull();
  });

  it('a native range reaching across cells becomes the grid selection', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    try {
      const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      const r = document.createRange();
      r.setStart(cellEl(1, 0).firstChild!, 0);
      r.setEnd(cellEl(2, 1).firstChild!, 1);
      sel.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));

      expect(selectionOf(surface)).toEqual(cells([1, 0], [2, 1]));
      expect(window.getSelection()?.isCollapsed).toBe(true);
      expect(caretCell(), 'parked in the anchor cell').toEqual([1, 0]);
    } finally {
      raf.mockRestore();
    }
  });
});

describe('Cmd+A climbs text, cell, table, document', () => {
  it('from a caret in uncovered text: the text, then the cell, then the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    caretIn(1, 1, 0);

    key(surface, { key: 'a', metaKey: true });
    expect(surface.getTableSelection(), 'first rung is the text').toBeNull();
    expect(window.getSelection()?.toString()).toBe('2');

    key(surface, { key: 'a', metaKey: true });
    expect(selectionOf(surface), 'second rung is the cell').toEqual(cells([1, 1], [1, 1]));

    key(surface, { key: 'a', metaKey: true });
    expect(selectionOf(surface), 'third rung is the table').toEqual({ kind: 'table' });

    key(surface, { key: 'a', metaKey: true });
    expect(surface.getTableSelection(), 'fourth rung hands off to the document').toBeNull();
    expect(window.getSelection()?.rangeCount ?? 0).toBe(1);
  });

  it('Escape from the whole table returns the caret to where it came from, offset and all', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    caretIn(2, 1, 1); // after "5"
    key(surface, { key: 'a', metaKey: true }); // the text
    key(surface, { key: 'a', metaKey: true }); // the cell
    key(surface, { key: 'a', metaKey: true }); // the table
    expect(selectionOf(surface)).toEqual({ kind: 'table' });

    key(surface, { key: 'Escape' });

    expect(surface.getTableSelection()).toBeNull();
    expect(caretCell()).toEqual([2, 1]);
  });
});

describe('dissolving the selection', () => {
  it('Escape steps down to a caret in the anchor without changing the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableId(surface), at(2, 2), at(0, 0));

    const e = key(surface, { key: 'Escape' });

    expect(e.defaultPrevented).toBe(true);
    expect(surface.getTableSelection()).toBeNull();
    expect(container.classList.contains('sk-grid-selected')).toBe(false);
    expect(caretCell(), 'the anchor, not the top-left').toEqual([2, 2]);
    expect(grid(surface)).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6']
    ]);
  });

  it('a printable key clears the rectangle and types into the anchor', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableId(surface), at(1, 1), at(2, 2));

    const e = key(surface, { key: 'x' });

    expect(e.defaultPrevented).toBe(true);
    expect(surface.getTableSelection()).toBeNull();
    expect(grid(surface)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x', ''],
      ['4', '', '']
    ]);
    expect(caretCell()).toEqual([1, 1]);
    surface.undo();
    expect(grid(surface)[1], 'one undo restores the rectangle').toEqual(['1', '2', '3']);
  });

  it('Enter and a plain arrow dissolve to the anchor caret, leaving the cells alone', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableId(surface), at(1, 2), at(2, 0));
    key(surface, { key: 'Enter' });
    expect(surface.getTableSelection()).toBeNull();
    expect(caretCell()).toEqual([1, 2]);
    expect(grid(surface)[1]).toEqual(['1', '2', '3']);
  });

  it('lets undo/redo chords fall through instead of consuming them', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 1);
    const e = key(surface, { key: 'z', metaKey: true });
    // Not consumed by the grid-selection handler — the normal undo path owns it.
    expect(e.defaultPrevented).toBe(false);
  });

  it('a real DOM selection appearing inside the surface dissolves it', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    try {
      const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
      surface.selectTableRow(tableId(surface), 1);
      caretIn(0, 0, 0); // a click placed a caret
      document.dispatchEvent(new Event('selectionchange'));
      expect(surface.getTableSelection()).toBeNull();
    } finally {
      raf.mockRestore();
    }
  });
});

describe('selection is mutually exclusive with block selection', () => {
  it('selecting a row clears a prior whole-table block selection ring', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    caretIn(1, 0);
    key(surface, { key: 'Escape' }); // block-selects the table
    expect(container.querySelector('table')!.hasAttribute('data-block-selected')).toBe(true);

    surface.selectTableRow(tableId(surface), 1);

    expect(container.querySelector('table')!.hasAttribute('data-block-selected')).toBe(false);
    expect(surface.getTableSelection()).not.toBeNull();
  });
});

describe('the selection is readable and observable (for the chrome)', () => {
  it('exposes the current selection and clears it on dissolve', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    expect(surface.getTableSelection()).toBeNull();

    surface.selectTableColumn(tableId(surface), 2);
    expect(surface.getTableSelection()).toEqual({ tableId: tableId(surface), selection: cells([0, 2], [2, 2]) });

    key(surface, { key: 'Escape' });
    expect(surface.getTableSelection()).toBeNull();
  });

  it('notifies subscribers when the selection is set and cleared', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    let hits = 0;
    const off = surface.onTableSelectionChange(() => {
      hits += 1;
    });

    surface.selectTableRow(tableId(surface), 1);
    key(surface, { key: 'Escape' });
    expect(hits).toBe(2); // one set, one clear

    off();
    surface.selectTableRow(tableId(surface), 1);
    expect(hits).toBe(2); // unsubscribed
  });
});

describe('the table menu is on demand, for a cell rectangle', () => {
  const rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  const one = (row: number, col: number) => ({ minRow: row, minCol: col, maxRow: row, maxCol: col });

  it('opens for a cell target without selecting anything, and closes on demand', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const states: Array<TableMenuState | null> = [];
    surface.onTableMenu((s) => states.push(s));

    surface.openTableMenu(tableId(surface), one(1, 2), rect);
    expect(states.at(-1)).toMatchObject({ tableId: tableId(surface), cells: one(1, 2) });
    expect(surface.getTableSelection()).toBeNull();

    surface.closeTableMenu();
    expect(states.at(-1)).toBeNull();
  });

  it('a right-click target inside a cell opens the menu for that cell, anchored at the pointer', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const states: Array<TableMenuState | null> = [];
    surface.onTableMenu((s) => states.push(s));

    expect(surface.openTableMenuAtNode(cellEl(2, 1).firstChild, 40, 50)).toBe(true);
    expect(states.at(-1)).toMatchObject({ tableId: tableId(surface), cells: one(2, 1) });
    expect(states.at(-1)!.rect.left).toBe(40);
    expect(states.at(-1)!.rect.top).toBe(50);
  });

  it('a right-click inside the grid selection targets the selection; outside it, the cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const states: Array<TableMenuState | null> = [];
    surface.onTableMenu((s) => states.push(s));
    surface.selectTableCells(tableId(surface), at(1, 0), at(2, 1));

    surface.openTableMenuAtNode(cellEl(2, 1).firstChild, 0, 0);
    expect(states.at(-1)!.cells).toEqual({ minRow: 1, minCol: 0, maxRow: 2, maxCol: 1 });

    surface.openTableMenuAtNode(cellEl(0, 2).firstChild, 0, 0);
    expect(states.at(-1)!.cells).toEqual(one(0, 2));
  });

  it('a right-click target outside any cell declines, leaving the platform menu', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const states: Array<TableMenuState | null> = [];
    surface.onTableMenu((s) => states.push(s));

    expect(surface.openTableMenuAtNode(container.querySelector('p')!.firstChild, 0, 0)).toBe(false);
    expect(surface.openTableMenuAtNode(document.body, 0, 0)).toBe(false);
    expect(states.filter((s) => s !== null)).toHaveLength(0);
  });

  it('Shift+F10 and the ContextMenu key open the menu for the caret cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const states: Array<TableMenuState | null> = [];
    surface.onTableMenu((s) => states.push(s));
    caretIn(1, 2);

    const e = key(surface, { key: 'F10', shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(states.at(-1)).toMatchObject({ tableId: tableId(surface), cells: one(1, 2) });

    surface.closeTableMenu();
    const e2 = key(surface, { key: 'ContextMenu' });
    expect(e2.defaultPrevented).toBe(true);
    expect(states.at(-1)).toMatchObject({ tableId: tableId(surface), cells: one(1, 2) });
  });

  it('the menu key with a grid selection opens the menu for its shape', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const states: Array<TableMenuState | null> = [];
    surface.onTableMenu((s) => states.push(s));
    surface.selectTableColumn(tableId(surface), 1);

    const e = key(surface, { key: 'F10', shiftKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(states.at(-1)!.cells).toEqual({ minRow: 0, minCol: 1, maxRow: 2, maxCol: 1 });
    expect(surface.getTableSelection(), 'the selection is untouched').not.toBeNull();
  });

  it('the menu key outside a table is left to the platform', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const states: Array<TableMenuState | null> = [];
    surface.onTableMenu((s) => states.push(s));
    const p = container.querySelector('p')!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(p.firstChild!, 1);
    r.collapse(true);
    sel.addRange(r);

    const e = key(surface, { key: 'F10', shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(states.filter((s) => s !== null)).toHaveLength(0);
  });

  it('removeTableColumnAt removes the addressed column', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.removeTableColumnAt(tableId(surface), 0);
    expect(grid(surface)).toEqual([
      ['b', 'c'],
      ['2', '3'],
      ['5', '6']
    ]);
  });

  it('removeTableRowsAt removes a run of rows as one undo step', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.removeTableRowsAt(tableId(surface), 1, 2);
    expect(grid(surface)).toEqual([['a', 'b', 'c']]);
    surface.undo();
    expect(grid(surface)).toHaveLength(3);
  });

  it('setColumnAlignment paints the physical text-align on the column and re-serializes', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.setColumnAlignment(tableId(surface), 1, 'center');

    // Every cell of column 1 carries the physical align; column 0 is untouched.
    for (const el of container.querySelectorAll('[data-cell-col="1"]')) {
      expect((el as HTMLElement).style.textAlign).toBe('center');
    }
    expect((container.querySelector('[data-cell-col="0"]') as HTMLElement).style.textAlign).toBe('');
    expect(tableBlock(surface).align).toEqual([null, 'center', null]);
  });

  it('removeTableRowAt on a single-column table removes the header and promotes the body', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('| a |\n| - |\n| 1 |\n') });
    surface.removeTableRowAt(tableId(surface), 0);
    expect(surface.getDocument().blocks.some((b) => b.type === 'table')).toBe(true);
    expect(grid(surface)).toEqual([['1']]);
  });
});
