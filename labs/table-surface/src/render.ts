// The table element, built from a model. Stateless: the host calls this when it
// renders a block and replaces the element wholesale on structural change. The
// cell content is the host's (renderCell); everything else about the grid is
// decided here. The stateful mount/update surface of the contract lands with
// the selection and clipboard work, on top of this builder.

import { CELL_COL_ATTR, CELL_ROW_ATTR, type CellRef, type TableModel } from './contract';

/** Marks a table that carries explicit column widths (fixed layout). */
export const WIDTHS_CLASS = 'has-col-widths';

export type CellRenderer<Cell> = (cell: Cell, into: HTMLElement, ref: CellRef) => void;

/**
 * Build a `<table>` for `model`. Explicit widths switch it to fixed layout via
 * a `<colgroup>`; absent or malformed widths keep auto layout. Row 0 renders as
 * `<th>`. Cells carry their coordinates, resolve direction individually, and
 * take the column's physical alignment when one is set. The table element
 * itself stays direction-neutral so the column order never flips.
 */
export function renderTableElement<Cell>(
  model: TableModel<Cell>,
  renderCell: CellRenderer<Cell>,
  doc: Document = document
): HTMLTableElement {
  const el = doc.createElement('table');
  const cols = model.rows[0]?.length ?? 0;
  const widths = model.widths;
  if (widths && widths.length === cols && cols > 0) {
    let total = 0;
    for (const w of widths) if (w > 0) total += w;
    if (total > 0) {
      el.classList.add(WIDTHS_CLASS);
      const colgroup = doc.createElement('colgroup');
      for (let c = 0; c < cols; c++) {
        const raw = widths[c] ?? 0;
        const w = raw > 0 ? raw : 0;
        const colEl = doc.createElement('col');
        colEl.style.width = `${(w / total) * 100}%`;
        colgroup.appendChild(colEl);
      }
      el.appendChild(colgroup);
    }
  }
  const tbody = doc.createElement('tbody');
  model.rows.forEach((row, r) => {
    const tr = doc.createElement('tr');
    row.forEach((cell, c) => {
      const cellEl = doc.createElement(r === 0 ? 'th' : 'td');
      cellEl.setAttribute(CELL_ROW_ATTR, String(r));
      cellEl.setAttribute(CELL_COL_ATTR, String(c));
      cellEl.setAttribute('dir', 'auto');
      const align = model.align[c];
      if (align) cellEl.style.textAlign = align;
      renderCell(cell, cellEl, { row: r, col: c });
      tr.appendChild(cellEl);
    });
    tbody.appendChild(tr);
  });
  el.appendChild(tbody);
  return el;
}

/**
 * Preview column widths by writing them onto the live `<colgroup>`: no model
 * change, no re-render. Mirrors renderTableElement's colgroup so the preview
 * and the committed result look identical. Creates the colgroup, and opts the
 * table into fixed layout, on the first move of a width-free table.
 */
export function applyLiveColWidths(table: HTMLTableElement, widths: readonly number[]): void {
  let total = 0;
  for (const w of widths) if (w > 0) total += w;
  if (total <= 0) return;
  let colgroup = table.querySelector<HTMLTableColElement>(':scope > colgroup');
  if (!colgroup) {
    colgroup = table.ownerDocument.createElement('colgroup');
    for (let i = 0; i < widths.length; i++) colgroup.appendChild(table.ownerDocument.createElement('col'));
    table.insertBefore(colgroup, table.firstChild);
  }
  table.classList.add(WIDTHS_CLASS);
  const cols = colgroup.children;
  for (let i = 0; i < widths.length && i < cols.length; i++) {
    (cols[i] as HTMLElement).style.width = `${((widths[i]! > 0 ? widths[i]! : 0) / total) * 100}%`;
  }
}
