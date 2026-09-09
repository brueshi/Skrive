// The structural ops over an opaque cell type. String cells keep the tests
// legible; the host's own adapter tests cover the inline-node cell type.

import { describe, expect, it } from 'vitest';
import {
  clearCells,
  fillCells,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  reduce,
  removeColumn,
  removeColumns,
  removeRow,
  removeRows,
  setColumnAlign,
  setColumnWidths,
  type TableModel
} from '../src';

const empty = () => '';

function grid(rows: string[][], extra: Partial<TableModel<string>> = {}): TableModel<string> {
  const cols = rows[0]?.length ?? 0;
  return { align: Array.from({ length: cols }, () => null), rows, ...extra };
}

const TWO = () =>
  grid([
    ['a', 'b'],
    ['1', '2']
  ]);

/** A body row shorter than the header, hand-built: raggedness never parses. */
const RAGGED = () => grid([['a', 'b'], ['x']]);

describe('clearCells', () => {
  it('empties the covered cells and keeps the shape', () => {
    const m = clearCells(TWO(), { minRow: 1, minCol: 0, maxRow: 1, maxCol: 1 }, empty);
    expect(m.rows).toEqual([
      ['a', 'b'],
      ['', '']
    ]);
  });

  it('asks the host for each empty cell rather than sharing one', () => {
    let n = 0;
    clearCells(TWO(), { minRow: 0, minCol: 0, maxRow: 1, maxCol: 1 }, () => String(n++));
    expect(n).toBe(4);
  });
});

describe('insertRow', () => {
  it('inserts an empty row at the index, header width', () => {
    expect(insertRow(TWO(), 1, empty).rows).toEqual([
      ['a', 'b'],
      ['', ''],
      ['1', '2']
    ]);
  });

  it('clamps the index to the row count (append)', () => {
    expect(insertRow(TWO(), 99, empty).rows[2]).toEqual(['', '']);
    expect(insertRow(TWO(), -5, empty).rows[0]).toEqual(['', '']);
  });

  it('leaves align and widths untouched', () => {
    const m = insertRow(grid([['a', 'b']], { align: ['left', 'right'], widths: [3, 1] }), 1, empty);
    expect(m.align).toEqual(['left', 'right']);
    expect(m.widths).toEqual([3, 1]);
  });
});

describe('insertColumn', () => {
  it('splices an empty cell into every row and a null align entry', () => {
    const m = insertColumn(TWO(), 1, empty);
    expect(m.rows).toEqual([
      ['a', '', 'b'],
      ['1', '', '2']
    ]);
    expect(m.align).toEqual([null, null, null]);
    expect(m.align.length).toBe(m.rows[0]!.length);
  });

  it('grows a ragged row at its own end rather than padding it', () => {
    const m = insertColumn(RAGGED(), 1, empty);
    expect(m.rows[0]!.length).toBe(3);
    expect(m.rows[1]).toEqual(['x', '']);
  });

  it('splices the average weight when widths are set, in lockstep', () => {
    const m = insertColumn(grid([['a', 'b']], { widths: [3, 1] }), 1, empty);
    expect(m.widths).toEqual([3, 2, 1]);
  });

  it('leaves a width-free table width-free', () => {
    expect(insertColumn(TWO(), 1, empty).widths).toBeUndefined();
  });
});

describe('removeRow', () => {
  it('removes a body row', () => {
    expect(removeRow(TWO(), 1)!.rows).toEqual([['a', 'b']]);
  });

  it('promotes the next row when the header is removed; align survives', () => {
    const m = removeRow(grid([['a', 'b'], ['1', '2']], { align: ['left', 'right'] }), 0)!;
    expect(m.rows).toEqual([['1', '2']]);
    expect(m.align).toEqual(['left', 'right']);
  });

  it('returns null when it would empty the table or the index is out of range', () => {
    expect(removeRow(grid([['a', 'b']]), 0)).toBeNull();
    expect(removeRow(TWO(), 2)).toBeNull();
    expect(removeRow(TWO(), -1)).toBeNull();
  });
});

describe('removeColumn', () => {
  it('removes the column, its align entry, and its weight', () => {
    const m = removeColumn(grid([['a', 'b', 'c'], ['1', '2', '3']], { align: ['left', null, 'right'], widths: [2, 3, 5] }), 1)!;
    expect(m.rows).toEqual([
      ['a', 'c'],
      ['1', '3']
    ]);
    expect(m.align).toEqual(['left', 'right']);
    expect(m.widths).toEqual([2, 5]);
  });

  it('leaves a ragged row without that column untouched', () => {
    const m = removeColumn(RAGGED(), 1)!;
    expect(m.rows).toEqual([['a'], ['x']]);
    expect(m.align).toEqual([null]);
  });

  it('returns null for a single-column table or an out-of-range index', () => {
    expect(removeColumn(grid([['a'], ['1']]), 0)).toBeNull();
    expect(removeColumn(TWO(), 2)).toBeNull();
  });
});

describe('removeRows', () => {
  const THREE = () =>
    grid([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6']
    ]);

  it('removes an inclusive range as one change', () => {
    expect(removeRows(THREE(), 1, 2)!.rows).toEqual([
      ['a', 'b'],
      ['5', '6']
    ]);
  });

  it('declines a range that would empty the table, is out of order, or out of range', () => {
    expect(removeRows(THREE(), 0, 3)).toBeNull();
    expect(removeRows(THREE(), 2, 1)).toBeNull();
    expect(removeRows(THREE(), 1, 4)).toBeNull();
    expect(removeRows(THREE(), -1, 0)).toBeNull();
  });

  it('is what removeRow is made of', () => {
    expect(removeRow(THREE(), 2)).toEqual(removeRows(THREE(), 2, 2));
  });
});

describe('removeColumns', () => {
  const WIDE = () =>
    grid([['a', 'b', 'c', 'd'], ['1', '2', '3', '4']], { align: ['left', null, 'right', 'center'], widths: [1, 2, 3, 4] });

  it('removes the cells, align entries, and weights of an inclusive range in lockstep', () => {
    const m = removeColumns(WIDE(), 1, 2)!;
    expect(m.rows).toEqual([
      ['a', 'd'],
      ['1', '4']
    ]);
    expect(m.align).toEqual(['left', 'center']);
    expect(m.widths).toEqual([1, 4]);
  });

  it('leaves a ragged row its own end', () => {
    const m = removeColumns(grid([['a', 'b', 'c'], ['x']]), 1, 2)!;
    expect(m.rows).toEqual([['a'], ['x']]);
  });

  it('declines a range that would leave no column, is out of order, or out of range', () => {
    expect(removeColumns(WIDE(), 0, 3)).toBeNull();
    expect(removeColumns(WIDE(), 2, 1)).toBeNull();
    expect(removeColumns(WIDE(), 3, 4)).toBeNull();
  });
});

describe('setColumnAlign', () => {
  it('sets the alignment and pads a short align array to the header width', () => {
    const m = setColumnAlign(grid([['a', 'b', 'c']], { align: [null] }), 2, 'right')!;
    expect(m.align).toEqual([null, null, 'right']);
  });

  it('returns null when unchanged or out of range', () => {
    expect(setColumnAlign(TWO(), 0, null)).toBeNull();
    expect(setColumnAlign(TWO(), 5, 'left')).toBeNull();
  });
});

describe('setColumnWidths', () => {
  it('replaces the weights with a fresh copy', () => {
    const input = [3, 1];
    const m = setColumnWidths(TWO(), input)!;
    expect(m.widths).toEqual([3, 1]);
    expect(m.widths).not.toBe(input);
  });

  it('returns null on a length mismatch, a bad entry, or an equal set', () => {
    expect(setColumnWidths(TWO(), [1, 2, 3])).toBeNull();
    expect(setColumnWidths(TWO(), [0, 1])).toBeNull();
    expect(setColumnWidths(TWO(), [Infinity, 1])).toBeNull();
    expect(setColumnWidths(grid([['a', 'b']], { widths: [3, 1] }), [3, 1])).toBeNull();
  });
});

describe('moveRow', () => {
  const THREE = () => grid([['h', 'h'], ['1', '1'], ['2', '2'], ['3', '3']]);

  it('moves a body row to a drop boundary', () => {
    expect(moveRow(THREE(), 1, 4)!.rows.map((r) => r[0])).toEqual(['h', '2', '3', '1']);
    expect(moveRow(THREE(), 3, 1)!.rows.map((r) => r[0])).toEqual(['h', '3', '1', '2']);
  });

  it('pins the header: it never moves and nothing drops above it', () => {
    expect(moveRow(THREE(), 0, 2)).toBeNull();
    expect(moveRow(THREE(), 2, 0)).toBeNull();
  });

  it('returns null for the flanking boundaries (no reorder)', () => {
    expect(moveRow(THREE(), 2, 2)).toBeNull();
    expect(moveRow(THREE(), 2, 3)).toBeNull();
  });
});

describe('moveColumn', () => {
  it('moves cells, align, and widths in lockstep', () => {
    const m = moveColumn(grid([['a', 'b', 'c'], ['1', '2', '3']], { align: ['left', null, 'right'], widths: [1, 2, 3] }), 0, 3)!;
    expect(m.rows).toEqual([
      ['b', 'c', 'a'],
      ['2', '3', '1']
    ]);
    expect(m.align).toEqual([null, 'right', 'left']);
    expect(m.widths).toEqual([2, 3, 1]);
  });

  it('leaves a ragged row without the column untouched and clamps a short row', () => {
    const m = moveColumn(grid([['a', 'b', 'c'], ['x']]), 0, 3)!;
    expect(m.rows[0]).toEqual(['b', 'c', 'a']);
    expect(m.rows[1]).toEqual(['x']);
  });

  it('returns null out of range or on a flanking boundary', () => {
    expect(moveColumn(TWO(), 2, 0)).toBeNull();
    expect(moveColumn(TWO(), 0, 1)).toBeNull();
  });
});

describe('reduce', () => {
  it('dispatches intents to the ops', () => {
    expect(reduce(TWO(), { type: 'insert-row', index: 2 }, empty)!.rows.length).toBe(3);
    expect(reduce(TWO(), { type: 'set-align', col: 1, align: 'center' }, empty)!.align).toEqual([null, 'center']);
    expect(reduce(TWO(), { type: 'remove-row', index: 9 }, empty)).toBeNull();
    expect(reduce(grid([['a', 'b'], ['1', '2'], ['3', '4']]), { type: 'remove-rows', from: 1, to: 2 }, empty)!.rows).toEqual([['a', 'b']]);
    expect(reduce(grid([['a', 'b', 'c']]), { type: 'remove-columns', from: 0, to: 1 }, empty)!.rows).toEqual([['c']]);
  });

  it('dispatches fill-cells', () => {
    expect(reduce(TWO(), { type: 'fill-cells', at: { row: 0, col: 0 }, grid: [['z']], grow: false }, empty)!.rows[0]).toEqual(['z', 'b']);
  });
});

describe('fillCells', () => {
  const PASTE = [
    ['x', 'y'],
    ['z', 'w']
  ];

  it('lands the grid with its top-left at the cell', () => {
    const m = fillCells(grid([['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]), { row: 1, col: 1 }, PASTE, false, empty)!;
    expect(m.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x', 'y'],
      ['4', 'z', 'w']
    ]);
  });

  it('clips to the table without grow', () => {
    const m = fillCells(TWO(), { row: 1, col: 1 }, PASTE, false, empty)!;
    expect(m.rows).toEqual([
      ['a', 'b'],
      ['1', 'x']
    ]);
  });

  it('grows rows and columns to fit, keeping align and widths in step', () => {
    const m = fillCells(grid([['a', 'b']], { align: ['left', null], widths: [1, 3] }), { row: 0, col: 1 }, PASTE, true, empty)!;
    expect(m.rows).toEqual([
      ['a', 'x', 'y'],
      ['', 'z', 'w']
    ]);
    expect(m.align).toEqual(['left', null, null]);
    expect(m.widths).toEqual([1, 3, 2]);
  });

  it('keeps the incoming cells by reference and the untouched ones too', () => {
    const base = TWO();
    const m = fillCells(base, { row: 0, col: 0 }, [['q']], false, empty)!;
    expect(m.rows[0]![0]).toBe('q');
    expect(m.rows[1]).toBe(base.rows[1]);
  });

  it('declines an empty grid or a landing cell outside the table', () => {
    expect(fillCells(TWO(), { row: 0, col: 0 }, [], false, empty)).toBeNull();
    expect(fillCells(TWO(), { row: 0, col: 0 }, [[]], false, empty)).toBeNull();
    expect(fillCells(TWO(), { row: 2, col: 0 }, PASTE, true, empty)).toBeNull();
  });
});
