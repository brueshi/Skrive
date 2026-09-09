// Per-block hover chrome for tables — the gutters that let a writer add rows and
// columns by pointing at the table instead of by remembering a chord. The
// affordance grammar puts table structural editing here (per-block chrome), never
// on the toolbar, and this is the primary surface: a grip or `+` names its target
// row/column outright, so nothing is inferred from a collapsed caret that
// WKWebView may have already reset toward the start on focus change.
//
// Architecture mirrors decoration-overlay.ts: the gutters live in a layer element
// inside the scroller but OUTSIDE the contenteditable, so they can never corrupt
// the editable text or the caret, and they are positioned in the scroller's
// content coordinate space, so they ride scroll with no listener. The layer is
// built only while a table is hovered or focused, is O(rows + cols), and is
// rebuilt from the surface's structural-change signal — never from the keystroke
// path (typing re-renders a block in place and never reconciles).
//
// Geometry is MEASURED, not modelled: a column's width is decided by the browser
// from its content, and the block model holds no widths at all. So the slot
// positions come from the real th/td rects. The measurement step is isolated from
// the arithmetic below it, which is pure and unit-tested without layout (jsdom
// implements no box geometry).

import {
  GUTTER_METRICS,
  dropIndicatorRect,
  hoverZone,
  nearestBoundary,
  normalizeWidths,
  resizeColumnWidths,
  tableGutterSlots,
  tableHandleSlot,
  tableResizeSlots,
  zoneContains,
  type GutterSlot,
  type HoverCell,
  type HoverZone,
  type TableGeometry
} from '@skrive/table-surface';

// The pure geometry moved to the table-surface lab; re-exported here so the
// block chrome, the index, and the tests keep their import site.
export {
  GUTTER_METRICS,
  dropIndicatorRect,
  hoverZone,
  nearestBoundary,
  normalizeWidths,
  resizeColumnWidths,
  tableGutterSlots,
  tableHandleSlot,
  tableResizeSlots,
  zoneContains
} from '@skrive/table-surface';
export type { DropIndicator, GutterMetrics, GutterSlot, HoverCell, HoverZone, TableGeometry } from '@skrive/table-surface';
import { contentBox, type ContentBox } from './decoration-overlay';
import { BLOCK_ID_ATTR } from './render';
import type { BlockSurface } from './surface';

/** How long, in ms, the chrome lingers after the pointer leaves the zone. A short
 *  delay (cancelled the instant the pointer returns) keeps a near-miss on a handle
 *  or a dip through the gutter from tearing the chrome down and back up. */
const HIDE_DELAY_MS = 140;

/** Minimum width, in px, a resize drag leaves a column — keeps every column
 *  grabbable and its handle hittable, and stops a neighbour from collapsing. */
const MIN_COLUMN_PX = 40;

/** Pointer travel, in px, before a boundary press becomes a resize drag. Below it a
 *  press-and-release stays a click, so a stray click on the border strip never
 *  converts an auto-layout table to explicit widths (a surprise undo step). */
const RESIZE_MOVE_THRESHOLD_PX = 3;

/** Body class held for the duration of a resize drag, so the col-resize cursor and
 *  the drawn boundary line persist even as the pointer leaves the thin grab strip. */
const RESIZING_CLASS = 'sk-col-resizing';

/** Pointer travel, in px, before a handle press becomes a reorder drag. Below it the
 *  press stays a click that selects the slice and opens its menu (SKR-266 B2). */
const REORDER_MOVE_THRESHOLD_PX = 4;

/** Body class held while a row/column is being dragged to a new position, for the
 *  grabbing cursor and to suppress text selection during the drag. */
const REORDERING_CLASS = 'sk-table-reordering';

/** Marks the cells of the slice currently being dragged, so it tints for the length
 *  of the drag — the "what am I moving" half of the feedback, paired with the
 *  drop-indicator line's "where will it land". View-only; cleared on drop. */
const DRAG_CELL_ATTR = 'data-cell-dragging';

/** Measure a rendered table into content-space geometry. Returns null for a table
 *  with no rows or no header cells — nothing to hang chrome on. */
export function measureTable(
  tableEl: HTMLTableElement,
  hostRect: { left: number; top: number },
  scrollLeft: number,
  scrollTop: number
): TableGeometry | null {
  const rows = Array.from(tableEl.rows);
  const header = rows[0];
  if (!header) return null;
  const headerCells = Array.from(header.cells);
  if (headerCells.length === 0) return null;

  const toContent = (el: Element): ContentBox =>
    contentBox(el.getBoundingClientRect(), hostRect, scrollLeft, scrollTop);

  const box = toContent(tableEl);
  const colEdges = headerCells.map((cell) => toContent(cell).x);
  colEdges.push(box.x + box.width);
  const rowEdges = rows.map((tr) => toContent(tr).y);
  rowEdges.push(box.y + box.height);

  return { box, colEdges, rowEdges };
}

export type TableChromeOptions = {
  /** The contenteditable host (.block-editor-surface) holding the tables. */
  surface: HTMLElement;
  /** The scrolling container (.block-editor-body); slots are positioned in its
   *  content coordinate space, so they ride the scroll with no listener. */
  scroller: HTMLElement;
  /** The layer element (.block-table-chrome-layer) the slots are appended to — a
   *  sibling of the surface, owned by the React tree. */
  layer: HTMLElement;
  /** The surface the add-affordances act on. */
  blockSurface: BlockSurface;
};

export type TableChromeHandle = { destroy(): void };

const SLOT_CLASS = 'sk-table-chrome';

/** Accessible labels per slot kind. Handles are 1-based for humans; the append
 *  rails read as plain actions. */
const SLOT_LABELS: Record<GutterSlot['kind'], (index: number) => string> = {
  'col-append': () => 'Add column',
  'row-append': () => 'Add row',
  'col-handle': (i) => `Select column ${i + 1}`,
  'row-handle': (i) => `Select row ${i + 1}`,
  'col-resize': (i) => `Resize column ${i + 1}`
};

/** Preview a resize by writing fractional widths straight onto the live table's
 *  `<colgroup>` — no model mutation, no reconcile, no serialize (that lands once on
 *  pointerup). Mirrors how render.ts builds the colgroup, so the drag preview and
 *  the committed result look identical; the commit's reconcile then replaces this
 *  element wholesale, discarding these transient styles. Creates the colgroup (and
 *  opts the table into fixed layout) on the first move of a width-free table. */
function applyLiveColWidths(table: HTMLTableElement, widths: number[]): void {
  let total = 0;
  for (const w of widths) if (w > 0) total += w;
  if (total <= 0) return;
  let colgroup = table.querySelector<HTMLTableColElement>(':scope > colgroup');
  if (!colgroup) {
    colgroup = document.createElement('colgroup');
    for (let i = 0; i < widths.length; i++) colgroup.appendChild(document.createElement('col'));
    table.insertBefore(colgroup, table.firstChild);
  }
  table.classList.add('has-col-widths');
  const cols = colgroup.children;
  for (let i = 0; i < widths.length && i < cols.length; i++) {
    (cols[i] as HTMLElement).style.width = `${((widths[i]! > 0 ? widths[i]! : 0) / total) * 100}%`;
  }
}

/** Wire table hover chrome to a surface. Returns a handle whose destroy() removes
 *  every listener and slot. Mirrors attachDecorationOverlay's lifecycle. */
export function attachTableChrome({
  surface,
  scroller,
  layer,
  blockSurface
}: TableChromeOptions): TableChromeHandle {
  // The table whose chrome is up (or null), and which of its cells the pointer is
  // over — the contextual handles track the hovered row and column, Notion-style.
  let active: HTMLTableElement | null = null;
  let hoverRow: number | null = null;
  let hoverCol: number | null = null;
  // The surface's grip-selection, so the selected handle stays lit while the
  // selection is active, independent of hover.
  let selection = blockSurface.getTableSelection();
  let scheduled = false;
  let rafId = 0;
  let hideTimer = 0;
  let destroyed = false;
  // A handle press that became a reorder drag must swallow the click the browser
  // fires on release, so a drag doesn't also select the slice and open its menu.
  let suppressClick = false;
  // The teardown for an in-flight reorder gesture. Held at attach scope so a click
  // (which WKWebView fires even when it drops the pointerup on a motionless press)
  // and destroy() can both tidy a gesture's window listeners — no leak on a tap.
  let activeReorderCleanup: (() => void) | null = null;

  const clear = (): void => {
    layer.textContent = '';
  };

  /** Does this slot address the selected row/column? */
  const isSelectedSlot = (blockId: string, slot: GutterSlot): boolean =>
    selection !== null &&
    selection.tableId === blockId &&
    slot.kind === (selection.kind === 'col' ? 'col-handle' : 'row-handle') &&
    slot.index === selection.index;

  /** Build one slot's button and append it. */
  const renderSlot = (blockId: string, table: HTMLTableElement, slot: GutterSlot): void => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `${SLOT_CLASS} ${SLOT_CLASS}--${slot.kind}`;
    if (isSelectedSlot(blockId, slot)) el.classList.add('is-selected');
    el.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
    el.style.width = `${slot.width}px`;
    el.style.height = `${slot.height}px`;
    const index = slot.index;
    el.setAttribute('aria-label', SLOT_LABELS[slot.kind](index));
    // Bound to click, NOT pointerup: WKWebView drops pointerup on a motionless
    // press, and the Chromium latency gate is blind to that difference.
    el.addEventListener('click', (e) => {
      // A click that closes a motionless press tidies any reorder gesture whose
      // pointerup WKWebView may have dropped; then the press acts as a plain click.
      activeReorderCleanup?.();
      if (suppressClick) {
        // The click that follows a reorder drag: swallow it so the drop doesn't
        // also select the slice and open its menu.
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      switch (slot.kind) {
        case 'col-append':
          blockSurface.insertTableColumnAt(blockId, index, 0);
          break;
        case 'row-append':
          blockSurface.insertTableRowAt(blockId, index, 0);
          break;
        case 'col-handle':
          blockSurface.openTableMenu(blockId, 'col', index, el.getBoundingClientRect());
          break;
        case 'row-handle':
          blockSurface.openTableMenu(blockId, 'row', index, el.getBoundingClientRect());
          break;
      }
    });
    // A handle is also a reorder grip: a press that crosses the move threshold drags
    // the row/column to a new position (the header row's handle is click-only).
    if (slot.kind === 'col-handle' || slot.kind === 'row-handle') {
      el.addEventListener('pointerdown', (ev) => beginHandleReorder(ev, blockId, table, slot, el));
    }
    // Keep a press on the chrome from stealing the caret out of the cell before the
    // op runs.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    layer.appendChild(el);
  };

  /** Drag a row or column handle to a new position (SKR-271). The press stays a
   *  click (select + menu) until it crosses the move threshold, at which point it
   *  becomes a reorder: a drop-indicator line tracks the nearest boundary and the
   *  move commits once on release as a single undo step. The header row's handle
   *  never drags (pinned) and nothing drops above the header. Listens on the
   *  scroller/window rather than capturing the tiny handle, so a drag that wanders
   *  off the grip still tracks; cleanup runs on pointerup, pointercancel, or — if
   *  WKWebView drops the pointerup on a motionless press — the ensuing click. */
  const beginHandleReorder = (e: PointerEvent, blockId: string, table: HTMLTableElement, slot: GutterSlot, el: HTMLElement): void => {
    if (e.button !== 0) return;
    const kind: 'row' | 'col' = slot.kind === 'col-handle' ? 'col' : 'row';
    if (kind === 'row' && slot.index === 0) return; // header pinned: not draggable
    activeReorderCleanup?.(); // tidy any prior gesture that leaked
    const geom = measureTable(table, scroller.getBoundingClientRect(), scroller.scrollLeft, scroller.scrollTop);
    if (!geom) return;
    const edges = kind === 'col' ? geom.colEdges : geom.rowEdges;
    const from = slot.index;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    let dropTo = from;
    let indicator: HTMLElement | null = null;

    const cleanup = (): void => {
      scroller.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      activeReorderCleanup = null;
      if (moved) {
        document.body.classList.remove(REORDERING_CLASS);
        el.classList.remove('is-dragging');
        indicator?.remove();
        for (const c of table.querySelectorAll(`[${DRAG_CELL_ATTR}]`)) c.removeAttribute(DRAG_CELL_ATTR);
      }
    };
    const onMove = (ev: PointerEvent): void => {
      if (!moved) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < REORDER_MOVE_THRESHOLD_PX) return;
        moved = true;
        blockSurface.clearCaret();
        document.body.classList.add(REORDERING_CLASS);
        el.classList.add('is-dragging');
        // Tint the slice in flight so it's clear WHAT is moving, alongside the drop
        // line that shows WHERE. Both cleared on drop (cleanup).
        const sliceKey = kind === 'col' ? 'data-cell-col' : 'data-cell-row';
        for (const c of table.querySelectorAll(`[${sliceKey}="${from}"]`)) c.setAttribute(DRAG_CELL_ATTR, '');
        indicator = document.createElement('div');
        indicator.className = `${SLOT_CLASS} ${SLOT_CLASS}--drop-${kind}`;
        layer.appendChild(indicator);
      }
      const host = scroller.getBoundingClientRect();
      const pos =
        kind === 'col' ? ev.clientX - host.left + scroller.scrollLeft : ev.clientY - host.top + scroller.scrollTop;
      let to = nearestBoundary(edges, pos);
      if (kind === 'row') to = Math.max(1, to); // never drop above the pinned header
      dropTo = to;
      const r = dropIndicatorRect(geom, kind, to, 3);
      indicator!.style.transform = `translate(${r.x}px, ${r.y}px)`;
      indicator!.style.width = `${r.width}px`;
      indicator!.style.height = `${r.height}px`;
    };
    const onUp = (): void => {
      const didMove = moved;
      const to = dropTo;
      cleanup();
      if (didMove) {
        suppressClick = true;
        if (kind === 'col') blockSurface.moveTableColumnAt(blockId, from, to);
        else blockSurface.moveTableRowAt(blockId, from, to);
      }
    };
    activeReorderCleanup = cleanup;
    scroller.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  /** Run a column-resize drag from a boundary press. Pointer capture + pointer
   *  events (a real drag, so the motionless-press pointerup gotcha does not apply).
   *  The columns and the drawn line follow the pointer live by mutating the DOM
   *  directly; the model is committed once, on release, as a single undo step. A
   *  press that never crosses the move threshold stays a click and commits nothing,
   *  so a stray tap on the border never rewrites an auto table's widths. */
  const beginColumnResize = (e: PointerEvent, blockId: string, table: HTMLTableElement, slot: GutterSlot, el: HTMLElement): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const header = table.rows[0];
    if (!header || header.cells.length < 2) return;
    const startWidths = Array.from(header.cells, (c) => c.getBoundingClientRect().width);
    const startX = e.clientX;
    const boundary = slot.index;
    let current = startWidths;
    let moved = false;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort; the window-less path still works */
    }
    document.body.classList.add(RESIZING_CLASS);
    el.classList.add('is-resizing');

    const onMove = (ev: PointerEvent): void => {
      const delta = ev.clientX - startX;
      if (!moved && Math.abs(delta) < RESIZE_MOVE_THRESHOLD_PX) return;
      // On the transition from press to drag, drop the caret the press left in the
      // cell — a blinking insertion point under a column resize reads as a bug. A
      // sub-threshold press stays a click and never reaches here, so a plain click
      // near a border leaves the caret alone.
      if (!moved) blockSurface.clearCaret();
      moved = true;
      current = resizeColumnWidths(startWidths, boundary, delta, MIN_COLUMN_PX);
      applyLiveColWidths(table, current);
      // The drawn line rides with the boundary it moved (clamped delta), so it stays
      // pinned to the border the columns actually shifted to.
      const applied = current[boundary]! - startWidths[boundary]!;
      el.style.transform = `translate(${slot.x + applied}px, ${slot.y}px)`;
    };
    const end = (): void => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      document.body.classList.remove(RESIZING_CLASS);
      el.classList.remove('is-resizing');
      if (moved) blockSurface.setTableColumnWidths(blockId, normalizeWidths(current));
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  /** Build one resize strip. Not a button and not click-wired: it is a drag
   *  affordance (a caret never lands here — it sits on the border, in the cells'
   *  padding), so it carries only the pointerdown that starts the drag. */
  const renderResizeSlot = (blockId: string, table: HTMLTableElement, slot: GutterSlot): void => {
    const el = document.createElement('div');
    el.className = `${SLOT_CLASS} ${SLOT_CLASS}--col-resize`;
    el.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
    el.style.width = `${slot.width}px`;
    el.style.height = `${slot.height}px`;
    // Pointer-only refinement; the column menu (B2b) carries the keyboard/AT path.
    el.setAttribute('aria-hidden', 'true');
    el.addEventListener('pointerdown', (ev) => beginColumnResize(ev, blockId, table, slot, el));
    // A press here must not steal the caret before the drag arms.
    el.addEventListener('mousedown', (ev) => ev.preventDefault());
    layer.appendChild(el);
  };

  /** Render one table's chrome. `hovered` tables get the full set (rails + the
   *  hover handles); a table that only carries a selection gets just its selected
   *  handle, so the selection stays visible with the mouse away. */
  const renderTable = (table: HTMLTableElement, hovered: boolean): void => {
    if (!table.isConnected) return;
    const blockId = table.getAttribute(BLOCK_ID_ATTR);
    if (!blockId) return;
    const geom = measureTable(
      table,
      scroller.getBoundingClientRect(),
      scroller.scrollLeft,
      scroller.scrollTop
    );
    if (!geom) return;

    const slots = hovered ? tableGutterSlots(geom, { row: hoverRow, col: hoverCol }) : [];
    // Ensure the selected handle is present even when its slice isn't the hovered
    // one (or the table isn't hovered at all).
    if (selection && selection.tableId === blockId) {
      const already = slots.some((s) => isSelectedSlot(blockId, s));
      if (!already) {
        const s = tableHandleSlot(geom, selection.kind, selection.index);
        if (s) slots.push(s);
      }
    }
    for (const slot of slots) renderSlot(blockId, table, slot);
    // Resize strips are a hover-only refinement on the interior column boundaries;
    // they carry a drag, not a click, so they render on their own path.
    if (hovered) {
      for (const slot of tableResizeSlots(geom)) renderResizeSlot(blockId, table, slot);
    }
  };

  const paint = (): void => {
    scheduled = false;
    if (destroyed) return;
    clear();
    if (active && !active.isConnected) active = null;

    // The tables to draw: the hovered one (full chrome) and, if different, the one
    // carrying the selection (its handle only).
    if (active) renderTable(active, true);
    if (selection) {
      const selTable = layerSelectedTable();
      if (selTable && selTable !== active) renderTable(selTable, false);
    }
  };

  /** The element of the currently selected table, or null. */
  const layerSelectedTable = (): HTMLTableElement | null =>
    selection ? surface.querySelector<HTMLTableElement>(`table[${BLOCK_ID_ATTR}="${selection.tableId}"]`) : null;

  const schedule = (): void => {
    if (scheduled || destroyed) return;
    scheduled = true;
    rafId = requestAnimationFrame(paint);
  };

  const cancelHide = (): void => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
  };

  // Set the active table and hovered cell, repainting only when something actually
  // changed — so moving within one cell is free, and the chrome only rebuilds when
  // the table, row, or column under the pointer differs.
  const setState = (table: HTMLTableElement | null, row: number | null, col: number | null): void => {
    if (table === active && row === hoverRow && col === hoverCol) return;
    active = table;
    hoverRow = table ? row : null;
    hoverCol = table ? col : null;
    // Always repaint — even when clearing the hover, so a live selection's handle
    // stays lit (paint renders the selected table's handle independent of hover).
    schedule();
  };

  // Leave the chrome up for a beat, then drop it — cancelled the instant the
  // pointer comes back onto the table or its zone, so a near-miss on a handle or a
  // dip through the gutter never flickers the chrome away.
  const scheduleHide = (): void => {
    if (hideTimer || !active) return;
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      setState(null, null, null);
    }, HIDE_DELAY_MS);
  };

  /** The table cell under an element, with its model coordinates, or null. */
  const cellOf = (
    target: HTMLElement
  ): { table: HTMLTableElement; row: number; col: number } | null => {
    const cell = target.closest('th, td') as HTMLElement | null;
    if (!cell) return null;
    const table = cell.closest('table') as HTMLTableElement | null;
    if (!table) return null;
    const row = Number(cell.dataset.cellRow);
    const col = Number(cell.dataset.cellCol);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
    return { table, row, col };
  };

  // Hover tracking runs on the scroller, not the table, because the chrome sits
  // OUTSIDE the table element. Over a cell: adopt its table and coordinates. Over
  // a chrome element (a handle or rail) or anywhere in the grace zone (handle lane
  // / rail gap, which hit-test to no cell): hold the current state — crucially, do
  // NOT clear the hovered handle, or moving onto it to click would erase it. Only
  // when none of those holds does the chrome begin to fade.
  const onPointerOver = (e: PointerEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const cell = cellOf(target);
    if (cell) {
      cancelHide();
      setState(cell.table, cell.row, cell.col);
      return;
    }
    if (!active) return;
    if (layer.contains(target)) {
      cancelHide(); // over a handle or rail of the active table: keep it drawn
      return;
    }
    if (zoneContains(hoverZone(active.getBoundingClientRect()), e.clientX, e.clientY)) {
      cancelHide(); // in the grace zone: hold the current handles
      return;
    }
    scheduleHide(); // wandered off the table and its chrome
  };

  const onPointerLeave = (): void => scheduleHide();

  // Focus-within: tabbing or clicking into a cell surfaces the chrome without a
  // pointer, so the affordances are reachable from the keyboard path too.
  const onFocusIn = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const cell = cellOf(target);
    if (cell) setState(cell.table, cell.row, cell.col);
  };

  const onReflow = (): void => {
    if (active || selection) schedule();
  };

  // A structural pass rebuilds block elements wholesale (replaceWith), so every
  // measured rect is stale afterwards. This is the same signal the decoration
  // overlay and the code-highlight mirrors ride, and it is provably off the
  // keystroke path.
  const unsubscribe = blockSurface.onStructureChange(() => {
    // The element identity changed; re-resolve the active table by block id (a
    // structural op can also change the row/column count). paint re-measures both
    // the hovered and the selected table, so a repaint is all that's owed.
    if (active) {
      const blockId = active.getAttribute(BLOCK_ID_ATTR);
      active = blockId
        ? surface.querySelector<HTMLTableElement>(`table[${BLOCK_ID_ATTR}="${blockId}"]`)
        : null;
    }
    if (active || selection) schedule();
  });

  // The selected handle stays lit off the surface's selection state, so it
  // persists with the mouse away and clears when the selection dissolves.
  const unsubscribeSelection = blockSurface.onTableSelectionChange(() => {
    selection = blockSurface.getTableSelection();
    schedule();
  });

  // No scroll listener: the layer lives inside the scroller and its slots are
  // placed in content coordinates, so they ride the scroll for free — the same
  // reason the caret and the decoration overlay need none.
  scroller.addEventListener('pointerover', onPointerOver);
  scroller.addEventListener('pointerleave', onPointerLeave);
  surface.addEventListener('focusin', onFocusIn);
  window.addEventListener('resize', onReflow);
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onReflow) : null;
  resizeObserver?.observe(surface);

  return {
    destroy(): void {
      destroyed = true;
      unsubscribe();
      unsubscribeSelection();
      scroller.removeEventListener('pointerover', onPointerOver);
      scroller.removeEventListener('pointerleave', onPointerLeave);
      surface.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('resize', onReflow);
      resizeObserver?.disconnect();
      activeReorderCleanup?.(); // remove any in-flight reorder's window listeners
      if (scheduled) cancelAnimationFrame(rafId);
      cancelHide();
      active = null;
      clear();
    }
  };
}
