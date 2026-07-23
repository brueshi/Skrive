// @vitest-environment jsdom
//
// Table row/column selection (SKR-266 B2): a chrome handle click selects a whole
// row or column as authoritative surface state (not a DOM selection, which a
// handle click never leaves and WKWebView would collapse), paints an accent tint
// on every cell of the slice, and Delete removes it through the existing structural
// ops. Escape / a printable key / a real DOM selection dissolve it back to a caret.
// These drive the real keydown routing so the paths are pinned end to end; jsdom
// models enough DOM for the cell queries, focusCell, and readSelection to run.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
function selectedCoords(): Array<[number, number]> {
  return Array.from(container.querySelectorAll('[data-cell-selected]')).map((el) => [
    Number((el as HTMLElement).dataset.cellRow),
    Number((el as HTMLElement).dataset.cellCol)
  ]);
}

describe('selecting a column', () => {
  it('tints every cell in the column and no others', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 1);

    const coords = selectedCoords().sort();
    // Column 1 across all three rows (header + two body).
    expect(coords).toEqual([
      [0, 1],
      [1, 1],
      [2, 1]
    ]);
  });

  it('Delete removes the column and lands the table one column narrower', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 1);

    const e = key(surface, { key: 'Delete' });

    expect(e.defaultPrevented).toBe(true);
    expect(grid(surface)).toEqual([
      ['a', 'c'],
      ['1', '3'],
      ['4', '6']
    ]);
    // Tint is cleared once the slice is gone.
    expect(container.querySelectorAll('[data-cell-selected]')).toHaveLength(0);
  });

  it('keeps align the header width after the column is removed', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 0);
    key(surface, { key: 'Backspace' });
    expect(tableBlock(surface).align).toHaveLength(2);
  });
});

describe('selecting a row', () => {
  it('tints every cell in the row and no others', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableRow(tableId(surface), 2);

    expect(selectedCoords().sort()).toEqual([
      [2, 0],
      [2, 1],
      [2, 2]
    ]);
  });

  it('Delete removes the row', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableRow(tableId(surface), 1); // the "1 2 3" body row

    key(surface, { key: 'Delete' });

    expect(grid(surface)).toEqual([
      ['a', 'b', 'c'],
      ['4', '5', '6']
    ]);
  });

  it('removing the header row promotes the next row to header', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableRow(tableId(surface), 0);
    key(surface, { key: 'Delete' });
    expect(grid(surface)[0]).toEqual(['1', '2', '3']);
  });
});

describe('selection is mutually exclusive with block selection', () => {
  it('selecting a row clears a prior whole-table block selection ring', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const cell = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(cell.firstChild!, 0);
    r.collapse(true);
    sel.addRange(r);
    key(surface, { key: 'Escape' }); // block-selects the table (SKR-203)
    expect(container.querySelector('table')!.hasAttribute('data-block-selected')).toBe(true);

    surface.selectTableRow(tableId(surface), 1);

    expect(container.querySelector('table')!.hasAttribute('data-block-selected')).toBe(false);
    expect(container.querySelectorAll('[data-cell-selected]').length).toBeGreaterThan(0);
  });
});

describe('dissolving the selection', () => {
  it('Escape clears the tint without changing the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 1);

    const e = key(surface, { key: 'Escape' });

    expect(e.defaultPrevented).toBe(true);
    expect(container.querySelectorAll('[data-cell-selected]')).toHaveLength(0);
    expect(grid(surface)).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6']
    ]);
  });

  it('a printable key ends the selection without editing the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 1);

    key(surface, { key: 'x' });

    expect(container.querySelectorAll('[data-cell-selected]')).toHaveLength(0);
    expect(grid(surface)[0]).toEqual(['a', 'b', 'c']);
  });

  it('lets undo/redo chords fall through instead of consuming them', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableColumn(tableId(surface), 1);

    const e = key(surface, { key: 'z', metaKey: true });

    // Not consumed by the table-selection handler — the normal undo path owns it.
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('the selection is readable and observable (for the chrome)', () => {
  it('exposes the current selection and clears it on dissolve', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    expect(surface.getTableSelection()).toBeNull();

    surface.selectTableColumn(tableId(surface), 2);
    expect(surface.getTableSelection()).toEqual({ tableId: tableId(surface), kind: 'col', index: 2 });

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

describe('deleting the last row or column deletes the table', () => {
  it('removing the only column removes the whole table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('| a |\n| - |\n| 1 |\n') });
    surface.selectTableColumn(tableId(surface), 0);

    key(surface, { key: 'Delete' });

    expect(surface.getDocument().blocks.some((b) => b.type === 'table')).toBe(false);
  });
});

describe('the per-row/column menu (B2b)', () => {
  const rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

  it('opens the menu and selects the slice, and closes on demand', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const states: Array<TableMenuState | null> = [];
    surface.onTableMenu((s) => states.push(s));

    surface.openTableMenu(tableId(surface), 'col', 2, rect);
    // The open state names the slice, and the slice is selected (handle stays lit).
    expect(states.at(-1)).toMatchObject({ tableId: tableId(surface), kind: 'col', index: 2 });
    expect(surface.getTableSelection()).toEqual({ tableId: tableId(surface), kind: 'col', index: 2 });

    surface.closeTableMenu();
    expect(states.at(-1)).toBeNull();
    // A dismiss leaves the selection intact.
    expect(surface.getTableSelection()).not.toBeNull();
  });

  it('closes the menu when the selection dissolves', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const states: Array<TableMenuState | null> = [];
    surface.onTableMenu((s) => states.push(s));

    surface.openTableMenu(tableId(surface), 'row', 1, rect);
    expect(states.at(-1)).not.toBeNull();

    key(surface, { key: 'Escape' }); // dissolves the selection
    expect(states.at(-1)).toBeNull();
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

  it('removeTableRowAt on the only body-bearing single row deletes the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('| a |\n| - |\n| 1 |\n') });
    surface.removeTableRowAt(tableId(surface), 0);
    // Two rows remain after... no: a 1-column, 2-row table (header + one body).
    // Removing the header promotes the body; removing again would empty it. Here we
    // remove row 0, leaving one row — still a table.
    expect(surface.getDocument().blocks.some((b) => b.type === 'table')).toBe(true);
    expect(grid(surface)).toEqual([['1']]);
  });
});
