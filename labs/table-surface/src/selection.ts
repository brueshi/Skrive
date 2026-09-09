// The grid selection's arithmetic. One primitive, a cell rectangle held as an
// anchor and a focus; a row, a column, and the whole table are rectangles that
// span the grid, and the shape is derived here against the grid's dimensions,
// never stored. Pure: no DOM, no model access beyond its dimensions, so every
// rule verifies without layout and the host and the chrome share one answer.

import type { CellRect, CellRef, GridSelection, SelectionShape, TableModel } from './contract';

/** How many rows and columns the grid has. All a selection needs of the model. */
export type GridDims = { readonly rows: number; readonly cols: number };

export type Direction = 'up' | 'down' | 'left' | 'right';

/** Inclusive index ranges of the rows and columns a rectangle covers in full:
 *  the rows when it spans every column, the columns when it spans every row.
 *  What a structural remove may take away. */
export type FullSlices = {
  readonly rows: readonly [number, number] | null;
  readonly cols: readonly [number, number] | null;
};

/** Cmd+A's next rung: select the cell's text (the host's), a grid selection, or
 *  hand off beyond the table (the host's document-wide select). */
export type EscalateStep =
  | { readonly kind: 'text' }
  | { readonly kind: 'grid'; readonly selection: GridSelection }
  | { readonly kind: 'beyond' };

export function dimsOf<Cell>(model: TableModel<Cell>): GridDims {
  return { rows: model.rows.length, cols: model.rows[0]?.length ?? 0 };
}

/** The rectangle between two cells, whichever order they come in. */
export function cellRect(a: CellRef, b: CellRef): CellRect {
  return {
    minRow: Math.min(a.row, b.row),
    minCol: Math.min(a.col, b.col),
    maxRow: Math.max(a.row, b.row),
    maxCol: Math.max(a.col, b.col)
  };
}

function clampRef(ref: CellRef, dims: GridDims): CellRef {
  return {
    row: Math.max(0, Math.min(ref.row, dims.rows - 1)),
    col: Math.max(0, Math.min(ref.col, dims.cols - 1))
  };
}

/** The selection as a normalized rectangle, clamped to the grid so a selection
 *  that outlived a structural change still addresses real cells. */
export function normalize(sel: GridSelection, dims: GridDims): CellRect {
  if (sel.kind === 'table') return { minRow: 0, minCol: 0, maxRow: dims.rows - 1, maxCol: dims.cols - 1 };
  return cellRect(clampRef(sel.anchor, dims), clampRef(sel.focus, dims));
}

/** The cell typing lands in and Escape returns to: the anchor of a rectangle, the
 *  origin for the whole table. */
export function anchorOf(sel: GridSelection): CellRef {
  return sel.kind === 'table' ? { row: 0, col: 0 } : sel.anchor;
}

export function fullSlices(rect: CellRect, dims: GridDims): FullSlices {
  const allCols = rect.minCol === 0 && rect.maxCol >= dims.cols - 1;
  const allRows = rect.minRow === 0 && rect.maxRow >= dims.rows - 1;
  return {
    rows: allCols ? [rect.minRow, rect.maxRow] : null,
    cols: allRows ? [rect.minCol, rect.maxCol] : null
  };
}

/** What the selection amounts to. `row` and `col` cover one or more full slices;
 *  a rectangle that spans everything is the table however it was made. */
export function selectionShape(sel: GridSelection, dims: GridDims): SelectionShape {
  if (sel.kind === 'table') return 'table';
  const rect = normalize(sel, dims);
  const full = fullSlices(rect, dims);
  if (full.rows && full.cols) return 'table';
  if (full.rows) return 'row';
  if (full.cols) return 'col';
  return rect.minRow === rect.maxRow && rect.minCol === rect.maxCol ? 'cell' : 'cells';
}

/** Shift+Arrow: move the focus one cell, clamped to the grid. Returns the same
 *  object when nothing changes, so a host can skip a repaint. The whole table
 *  has nowhere to grow. */
export function extend(sel: GridSelection, dir: Direction, dims: GridDims): GridSelection {
  if (sel.kind === 'table') return sel;
  const focus = clampRef(
    {
      row: sel.focus.row + (dir === 'down' ? 1 : dir === 'up' ? -1 : 0),
      col: sel.focus.col + (dir === 'right' ? 1 : dir === 'left' ? -1 : 0)
    },
    dims
  );
  if (focus.row === sel.focus.row && focus.col === sel.focus.col) return sel;
  return { kind: 'cells', anchor: sel.anchor, focus };
}

/** Cmd+A's ladder: the cell's text, then the cell, then the table, then beyond.
 *  With no selection the caret decides: text that is not yet fully covered is
 *  the first rung; covered (or empty) text steps to the cell. */
export function escalate(
  sel: GridSelection | null,
  caret: { readonly cell: CellRef; readonly textCovered: boolean } | null
): EscalateStep {
  if (sel) return sel.kind === 'table' ? { kind: 'beyond' } : { kind: 'grid', selection: { kind: 'table' } };
  if (!caret) return { kind: 'beyond' };
  if (!caret.textCovered) return { kind: 'text' };
  return { kind: 'grid', selection: { kind: 'cells', anchor: caret.cell, focus: caret.cell } };
}

/** Escape's step back down, to a caret: the anchor of a rectangle, or null for
 *  the whole table, which carries no anchor so the host restores its own. */
export function stepDown(sel: GridSelection): CellRef | null {
  return sel.kind === 'table' ? null : sel.anchor;
}
