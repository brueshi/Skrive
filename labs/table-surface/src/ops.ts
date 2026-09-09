// Pure structural ops over a TableModel. Cells are opaque; an insert asks the
// host for an empty cell. Every op returns a fresh model, or null when it
// declines (out of range, or a no-op that should earn no history step). Row 0
// is the header and is pinned by the move ops.

import type { CellRect, CellRef, ColumnAlign, Reduce, TableModel } from './contract';

type Rows<Cell> = ReadonlyArray<ReadonlyArray<Cell>>;

function colCount<Cell>(m: TableModel<Cell>): number {
  return m.rows[0]?.length ?? 0;
}

function withWidths<Cell>(
  m: TableModel<Cell>,
  patch: { align?: readonly ColumnAlign[]; rows?: Rows<Cell> },
  widths: readonly number[] | undefined
): TableModel<Cell> {
  const next: { align: readonly ColumnAlign[]; rows: Rows<Cell>; widths?: readonly number[] } = {
    align: patch.align ?? m.align,
    rows: patch.rows ?? m.rows
  };
  if (widths) next.widths = widths;
  return next;
}

/** Empty every cell in `rect`; the shape survives. */
export function clearCells<Cell>(m: TableModel<Cell>, rect: CellRect, emptyCell: () => Cell): TableModel<Cell> {
  const rows = m.rows.map((row, r) =>
    r < rect.minRow || r > rect.maxRow
      ? row
      : row.map((cell, c) => (c < rect.minCol || c > rect.maxCol ? cell : emptyCell()))
  );
  return withWidths(m, { rows }, m.widths);
}

/** Insert an empty row at `index`, clamped to `[0, rowCount]`. */
export function insertRow<Cell>(m: TableModel<Cell>, index: number, emptyCell: () => Cell): TableModel<Cell> {
  const cols = colCount(m);
  const at = Math.max(0, Math.min(index, m.rows.length));
  const row = Array.from({ length: cols }, () => emptyCell());
  const rows = [...m.rows.slice(0, at), row, ...m.rows.slice(at)];
  return withWidths(m, { rows }, m.widths);
}

/**
 * Insert an empty column at `index`, clamped to `[0, colCount]`. Align gains a
 * null entry; widths, when present, gain the average weight. A ragged row
 * shorter than `index` grows at its own end and stays ragged.
 */
export function insertColumn<Cell>(m: TableModel<Cell>, index: number, emptyCell: () => Cell): TableModel<Cell> {
  const cols = colCount(m);
  const at = Math.max(0, Math.min(index, cols));
  const rows = m.rows.map((row) => {
    const next = [...row];
    next.splice(at, 0, emptyCell());
    return next;
  });
  const align = [...m.align];
  align.splice(at, 0, null);
  let widths: number[] | undefined;
  if (m.widths) {
    widths = [...m.widths];
    const avg = widths.length ? widths.reduce((sum, w) => sum + w, 0) / widths.length : 1;
    widths.splice(at, 0, avg);
  }
  return withWidths(m, { align, rows }, widths);
}

/** Remove row `index`. Null when out of range or it would empty the table. */
export function removeRow<Cell>(m: TableModel<Cell>, index: number): TableModel<Cell> | null {
  return removeRows(m, index, index);
}

/**
 * Remove rows `from` through `to` (inclusive) as one change. Null when the
 * range is out of order or out of range, or when it would empty the table.
 */
export function removeRows<Cell>(m: TableModel<Cell>, from: number, to: number): TableModel<Cell> | null {
  const n = m.rows.length;
  if (from < 0 || to < from || to >= n) return null;
  if (to - from + 1 >= n) return null;
  const rows = [...m.rows.slice(0, from), ...m.rows.slice(to + 1)];
  return withWidths(m, { rows }, m.widths);
}

/**
 * Remove column `index` from every row, its align entry, and its weight. A
 * ragged row without that column is untouched. Null when out of range or the
 * table has a single column.
 */
export function removeColumn<Cell>(m: TableModel<Cell>, index: number): TableModel<Cell> | null {
  return removeColumns(m, index, index);
}

/**
 * Remove columns `from` through `to` (inclusive) as one change: the cells, the
 * align entries, and the weights in lockstep. A ragged row keeps whatever it
 * has beyond its own end. Null when the range is out of order or out of range,
 * or when it would leave no column.
 */
export function removeColumns<Cell>(m: TableModel<Cell>, from: number, to: number): TableModel<Cell> | null {
  const cols = colCount(m);
  if (from < 0 || to < from || to >= cols) return null;
  if (to - from + 1 >= cols) return null;
  const count = to - from + 1;
  const rows = m.rows.map((row) => {
    if (from >= row.length) return row;
    const next = [...row];
    next.splice(from, count);
    return next;
  });
  const align = [...m.align];
  align.splice(from, count);
  let widths: number[] | undefined;
  if (m.widths) {
    widths = [...m.widths];
    widths.splice(from, count);
  }
  return withWidths(m, { align, rows }, widths);
}

/**
 * Set column `col`'s alignment. Null when out of range or unchanged. Align is
 * padded to the header width first, so the length invariant holds even
 * against a malformed input.
 */
export function setColumnAlign<Cell>(m: TableModel<Cell>, col: number, align: ColumnAlign): TableModel<Cell> | null {
  const cols = colCount(m);
  if (col < 0 || col >= cols) return null;
  if ((m.align[col] ?? null) === align) return null;
  const next = [...m.align];
  while (next.length < cols) next.push(null);
  next[col] = align;
  return withWidths(m, { align: next }, m.widths);
}

/**
 * Replace the per-column weights. Null on a length mismatch, a non-positive or
 * non-finite entry, or a set equal to the current one.
 */
export function setColumnWidths<Cell>(m: TableModel<Cell>, widths: readonly number[]): TableModel<Cell> | null {
  const cols = colCount(m);
  if (cols === 0 || widths.length !== cols) return null;
  if (!widths.every((w) => Number.isFinite(w) && w > 0)) return null;
  if (widthsEqual(m.widths, widths)) return null;
  return withWidths(m, {}, [...widths]);
}

function widthsEqual(a: readonly number[] | undefined, b: readonly number[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function spliceMove<T>(arr: readonly T[], from: number, insertAt: number): T[] {
  const next = arr.slice();
  const removed = next.splice(from, 1);
  next.splice(insertAt, 0, ...removed);
  return next;
}

/**
 * Move a body row. `to` is a drop boundary in `[0, rowCount]`, not a final
 * index. The header is pinned: `from` and `to` are both at least 1. Null when
 * out of range or the boundary flanks the row. Lands at `to > from ? to - 1 : to`.
 */
export function moveRow<Cell>(m: TableModel<Cell>, from: number, to: number): TableModel<Cell> | null {
  const n = m.rows.length;
  if (from < 1 || from >= n) return null;
  if (to < 1 || to > n) return null;
  if (to === from || to === from + 1) return null;
  const insertAt = to > from ? to - 1 : to;
  return withWidths(m, { rows: spliceMove(m.rows, from, insertAt) }, m.widths);
}

/**
 * Move a column. `to` is a drop boundary in `[0, colCount]`. Cells, align, and
 * widths move in lockstep; a ragged row without the column is untouched, and a
 * shorter row reinserts clamped to its own end. Null when out of range or the
 * boundary flanks the column.
 */
export function moveColumn<Cell>(m: TableModel<Cell>, from: number, to: number): TableModel<Cell> | null {
  const cols = colCount(m);
  if (from < 0 || from >= cols) return null;
  if (to < 0 || to > cols) return null;
  if (to === from || to === from + 1) return null;
  const insertAt = to > from ? to - 1 : to;
  const rows = m.rows.map((row) => {
    if (from >= row.length) return row;
    const next = [...row];
    const removed = next.splice(from, 1);
    next.splice(Math.min(insertAt, next.length), 0, ...removed);
    return next;
  });
  const align = spliceMove(m.align, from, insertAt);
  const widths = m.widths ? spliceMove(m.widths, from, insertAt) : undefined;
  return withWidths(m, { align, rows }, widths);
}

/**
 * Land a grid of cells with its top-left at `at`: the paste. With `grow` the
 * table gains the rows and columns the grid needs (through insertRow and
 * insertColumn, so align and widths keep their invariants); without it the
 * grid is clipped to the table. Null for an empty grid or an `at` outside the
 * table.
 */
export function fillCells<Cell>(
  m: TableModel<Cell>,
  at: CellRef,
  grid: ReadonlyArray<ReadonlyArray<Cell>>,
  grow: boolean,
  emptyCell: () => Cell
): TableModel<Cell> | null {
  const gridCols = grid.reduce((w, r) => Math.max(w, r.length), 0);
  if (grid.length === 0 || gridCols === 0) return null;
  if (at.row < 0 || at.row >= m.rows.length || at.col < 0 || at.col >= colCount(m)) return null;
  let next: TableModel<Cell> = m;
  if (grow) {
    while (next.rows.length < at.row + grid.length) next = insertRow(next, next.rows.length, emptyCell);
    while (colCount(next) < at.col + gridCols) next = insertColumn(next, colCount(next), emptyCell);
  }
  const rows = next.rows.map((row, r) => {
    const source = grid[r - at.row];
    if (!source) return row;
    return row.map((cell, c) => {
      const incoming = source[c - at.col];
      return c >= at.col && incoming !== undefined ? incoming : cell;
    });
  });
  return withWidths(next, { rows }, next.widths);
}

/** The intent dispatcher. */
export const reduce: Reduce = (model, intent, emptyCell) => {
  switch (intent.type) {
    case 'insert-row':
      return insertRow(model, intent.index, emptyCell);
    case 'insert-column':
      return insertColumn(model, intent.index, emptyCell);
    case 'remove-row':
      return removeRow(model, intent.index);
    case 'remove-column':
      return removeColumn(model, intent.index);
    case 'remove-rows':
      return removeRows(model, intent.from, intent.to);
    case 'remove-columns':
      return removeColumns(model, intent.from, intent.to);
    case 'move-row':
      return moveRow(model, intent.from, intent.to);
    case 'move-column':
      return moveColumn(model, intent.from, intent.to);
    case 'set-align':
      return setColumnAlign(model, intent.col, intent.align);
    case 'set-widths':
      return setColumnWidths(model, intent.widths);
    case 'clear-cells':
      return clearCells(model, intent.rect, emptyCell);
    case 'fill-cells':
      return fillCells(model, intent.at, intent.grid, intent.grow, emptyCell);
  }
};
