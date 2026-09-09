// The grid selection's arithmetic: shape, extension, the Cmd+A ladder, the
// Escape step, and the slices a rectangle covers in full. All against grid
// dimensions, no model or DOM.

import { describe, expect, it } from 'vitest';
import {
  anchorOf,
  cellRect,
  dimsOf,
  escalate,
  extend,
  fullSlices,
  normalize,
  selectionShape,
  stepDown,
  type GridSelection
} from '../src';

/** A 3-row, 3-column grid. */
const DIMS = { rows: 3, cols: 3 };
const at = (row: number, col: number) => ({ row, col });
const cells = (a: [number, number], f: [number, number]): GridSelection => ({
  kind: 'cells',
  anchor: at(a[0], a[1]),
  focus: at(f[0], f[1])
});
const TABLE: GridSelection = { kind: 'table' };

describe('normalize', () => {
  it('orders a backward rectangle', () => {
    expect(normalize(cells([2, 2], [0, 1]), DIMS)).toEqual({ minRow: 0, minCol: 1, maxRow: 2, maxCol: 2 });
  });

  it('clamps a rectangle that outlived a structural change', () => {
    expect(normalize(cells([0, 0], [9, 9]), DIMS)).toEqual({ minRow: 0, minCol: 0, maxRow: 2, maxCol: 2 });
  });

  it('spans the grid for the whole table', () => {
    expect(normalize(TABLE, DIMS)).toEqual({ minRow: 0, minCol: 0, maxRow: 2, maxCol: 2 });
  });

  it('cellRect and dimsOf are the plain helpers they look like', () => {
    expect(cellRect(at(1, 2), at(0, 0))).toEqual({ minRow: 0, minCol: 0, maxRow: 1, maxCol: 2 });
    expect(dimsOf({ align: [null, null], rows: [['a', 'b'], ['1', '2'], ['3', '4']] })).toEqual({ rows: 3, cols: 2 });
    expect(dimsOf({ align: [], rows: [] })).toEqual({ rows: 0, cols: 0 });
  });
});

describe('fullSlices and selectionShape', () => {
  it('a single cell is a cell; a partial block is cells', () => {
    expect(selectionShape(cells([1, 1], [1, 1]), DIMS)).toBe('cell');
    expect(selectionShape(cells([0, 0], [1, 1]), DIMS)).toBe('cells');
    expect(fullSlices(normalize(cells([0, 0], [1, 1]), DIMS), DIMS)).toEqual({ rows: null, cols: null });
  });

  it('a rectangle spanning every column is a row, or several', () => {
    expect(selectionShape(cells([1, 0], [1, 2]), DIMS)).toBe('row');
    expect(fullSlices(normalize(cells([1, 2], [2, 0]), DIMS), DIMS)).toEqual({ rows: [1, 2], cols: null });
  });

  it('a rectangle spanning every row is a column, or several', () => {
    expect(selectionShape(cells([0, 1], [2, 1]), DIMS)).toBe('col');
    expect(fullSlices(normalize(cells([2, 0], [0, 1]), DIMS), DIMS)).toEqual({ rows: null, cols: [0, 1] });
  });

  it('a rectangle spanning everything is the table, and so is the table kind', () => {
    expect(selectionShape(cells([2, 2], [0, 0]), DIMS)).toBe('table');
    expect(selectionShape(TABLE, DIMS)).toBe('table');
    expect(fullSlices(normalize(TABLE, DIMS), DIMS)).toEqual({ rows: [0, 2], cols: [0, 2] });
  });

  it('in a one-column grid every cell is a full row', () => {
    expect(selectionShape(cells([1, 0], [1, 0]), { rows: 3, cols: 1 })).toBe('row');
  });
});

describe('extend', () => {
  it('moves the focus one cell and keeps the anchor', () => {
    const next = extend(cells([1, 1], [1, 1]), 'right', DIMS);
    expect(next).toEqual(cells([1, 1], [1, 2]));
    expect(extend(next, 'down', DIMS)).toEqual(cells([1, 1], [2, 2]));
    expect(extend(cells([1, 1], [1, 1]), 'up', DIMS)).toEqual(cells([1, 1], [0, 1]));
    expect(extend(cells([1, 1], [1, 1]), 'left', DIMS)).toEqual(cells([1, 1], [1, 0]));
  });

  it('returns the same object at the grid edge', () => {
    const sel = cells([0, 0], [0, 2]);
    expect(extend(sel, 'right', DIMS)).toBe(sel);
    expect(extend(sel, 'up', DIMS)).toBe(sel);
  });

  it('the whole table has nowhere to grow', () => {
    expect(extend(TABLE, 'down', DIMS)).toBe(TABLE);
  });
});

describe('escalate', () => {
  it('a caret in uncovered text selects the text first', () => {
    expect(escalate(null, { cell: at(1, 1), textCovered: false })).toEqual({ kind: 'text' });
  });

  it('covered or empty text steps to the cell', () => {
    expect(escalate(null, { cell: at(1, 1), textCovered: true })).toEqual({
      kind: 'grid',
      selection: cells([1, 1], [1, 1])
    });
  });

  it('any rectangle steps to the table, and the table hands off beyond', () => {
    expect(escalate(cells([0, 0], [1, 1]), null)).toEqual({ kind: 'grid', selection: TABLE });
    expect(escalate(TABLE, null)).toEqual({ kind: 'beyond' });
  });

  it('with neither a selection nor a caret in a cell there is nothing to climb', () => {
    expect(escalate(null, null)).toEqual({ kind: 'beyond' });
  });
});

describe('stepDown and anchorOf', () => {
  it('a rectangle steps down to its anchor', () => {
    expect(stepDown(cells([2, 1], [0, 0]))).toEqual(at(2, 1));
    expect(anchorOf(cells([2, 1], [0, 0]))).toEqual(at(2, 1));
  });

  it('the whole table carries no anchor: null for the host to restore, origin to type into', () => {
    expect(stepDown(TABLE)).toBeNull();
    expect(anchorOf(TABLE)).toEqual(at(0, 0));
  });
});
