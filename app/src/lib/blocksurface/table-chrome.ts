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

import { contentBox, type ContentBox } from './decoration-overlay';
import { BLOCK_ID_ATTR } from './render';
import type { BlockSurface } from './surface';

/** A table's measured shape in the scroller's content coordinate space. */
export type TableGeometry = {
  /** The table element's own box. */
  box: ContentBox;
  /** `cols + 1` x positions: every column's start edge, then the table's right
   *  edge. Derived from the HEADER row, which is what defines the table's column
   *  count — a ragged body row is never allowed to widen the gutter. */
  colEdges: number[];
  /** `rows + 1` y positions: every row's start edge, then the table's bottom edge. */
  rowEdges: number[];
};

/** One painted affordance. `index` is a MODEL coordinate, not a pixel one: a
 *  handle carries the row/column it addresses (for selection and its menu in B2);
 *  an append carries the index a new row/column is inserted AT — the row/column
 *  count — which is exactly what insertTableRowAt / insertTableColumnAt take. */
export type GutterSlot = {
  kind: 'col-handle' | 'row-handle' | 'col-append' | 'row-append';
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Which row and column the pointer is over, or null when it is over neither (on
 *  a rail, say). Drives which contextual handle shows — the Notion model: one
 *  handle for the hovered column, one for the hovered row, not a full set. */
export type HoverCell = { row: number | null; col: number | null };

/** Chrome sizing. The gutters are an overlay, so these reserve no layout space —
 *  they only decide how far outside the table the chrome floats. */
export const GUTTER_METRICS = {
  /** Short dimension of a row/column handle bar. */
  handleThickness: 6,
  /** Gap between a handle and the table's edge. */
  handleGap: 5,
  /** Inset at each end of a handle, so a handle spans most of its cell but stops
   *  short of the neighbours — reads as "this column" without touching the next. */
  handleInset: 8,
  /** Short dimension of an append rail (the full-length `+` lanes). */
  railThickness: 16,
  /** Gap between an append rail and the table's edge. */
  railGap: 4
} as const;

export type GutterMetrics = typeof GUTTER_METRICS;

/** Grace margin, in px, added around the visible chrome to form the hover zone
 *  (see hoverZone). The gutters sit OUTSIDE the table, so reaching from a cell to
 *  a handle or rail crosses scroller background that belongs to no cell; without a
 *  grace zone that crossing reads as leaving the table and dismisses the chrome
 *  the pointer is heading for. */
const ZONE_SLACK = 10;

/** How long, in ms, the chrome lingers after the pointer leaves the zone. A short
 *  delay (cancelled the instant the pointer returns) keeps a near-miss on a handle
 *  or a dip through the gutter from tearing the chrome down and back up. */
const HIDE_DELAY_MS = 140;

/**
 * The slots for a measured table, Notion-shaped: two full-length append rails (a
 * `+` down the right to add a column, a `+` along the bottom to add a row) that
 * always show while the table is active, plus — contextually — a handle above the
 * hovered COLUMN and a handle left of the hovered ROW. At most four elements, so
 * a hovered table reads as calm rather than as a field of grips.
 *
 * The bottom append inserts at `rows` and the right at `cols` — appends, never a
 * mid-table insert. Mid-table insertion is the handle's job (its B2 menu) and the
 * `⌥⌘`-arrow chords, so nothing here has to guess an interior boundary.
 *
 * Pure: no DOM, no measurement. Everything it needs is in `geom` and `hover`.
 */
export function tableGutterSlots(
  geom: TableGeometry,
  hover: HoverCell,
  m: GutterMetrics = GUTTER_METRICS
): GutterSlot[] {
  const { box, colEdges, rowEdges } = geom;
  const cols = colEdges.length - 1;
  const rows = rowEdges.length - 1;
  if (cols < 1 || rows < 1) return [];

  const slots: GutterSlot[] = [];

  // Right rail: append a column. Full table height, just past the right edge.
  slots.push({
    kind: 'col-append',
    index: cols,
    x: box.x + box.width + m.railGap,
    y: box.y,
    width: m.railThickness,
    height: box.height
  });

  // Bottom rail: append a row. Full table width, just below the bottom edge.
  slots.push({
    kind: 'row-append',
    index: rows,
    x: box.x,
    y: box.y + box.height + m.railGap,
    width: box.width,
    height: m.railThickness
  });

  // Contextual column handle: a bar above the hovered column, spanning most of it.
  if (hover.col !== null && hover.col >= 0 && hover.col < cols) {
    const left = colEdges[hover.col]!;
    const width = colEdges[hover.col + 1]! - left;
    slots.push({
      kind: 'col-handle',
      index: hover.col,
      x: left + m.handleInset,
      y: box.y - m.handleGap - m.handleThickness,
      width: Math.max(width - 2 * m.handleInset, m.handleThickness),
      height: m.handleThickness
    });
  }

  // Contextual row handle: a bar left of the hovered row, spanning most of it.
  if (hover.row !== null && hover.row >= 0 && hover.row < rows) {
    const top = rowEdges[hover.row]!;
    const height = rowEdges[hover.row + 1]! - top;
    slots.push({
      kind: 'row-handle',
      index: hover.row,
      x: box.x - m.handleGap - m.handleThickness,
      y: top + m.handleInset,
      width: m.handleThickness,
      height: Math.max(height - 2 * m.handleInset, m.handleThickness)
    });
  }

  return slots;
}

/** A viewport-space rectangle: the pointer hit-test region. */
export type HoverZone = { left: number; top: number; right: number; bottom: number };

/**
 * The pointer zone a table "owns": its own rect, grown to cover the handle bars
 * (top and left) and the append rails (right and bottom), plus a slack margin.
 * While the pointer is inside this, the chrome stays up — so moving from a cell
 * out to a handle or a rail, across gutter background that hit-tests to no cell,
 * no longer reads as leaving the table.
 *
 * Pure over an already-measured rect, so it verifies without layout. `rect` is in
 * whatever space the caller measures in (viewport, at the call site).
 */
export function hoverZone(
  rect: { left: number; top: number; right: number; bottom: number },
  m: GutterMetrics = GUTTER_METRICS,
  slack = ZONE_SLACK
): HoverZone {
  const handleReach = m.handleGap + m.handleThickness;
  const railReach = m.railGap + m.railThickness;
  return {
    left: rect.left - handleReach - slack,
    top: rect.top - handleReach - slack,
    right: rect.right + railReach + slack,
    bottom: rect.bottom + railReach + slack
  };
}

/** Whether a point falls inside a zone. */
export function zoneContains(zone: HoverZone, x: number, y: number): boolean {
  return x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;
}

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
  let scheduled = false;
  let rafId = 0;
  let hideTimer = 0;
  let destroyed = false;

  const clear = (): void => {
    layer.textContent = '';
  };

  const paint = (): void => {
    scheduled = false;
    if (destroyed) return;
    clear();
    if (!active || !active.isConnected) {
      active = null;
      return;
    }
    const blockId = active.getAttribute(BLOCK_ID_ATTR);
    if (!blockId) return;
    const geom = measureTable(
      active,
      scroller.getBoundingClientRect(),
      scroller.scrollLeft,
      scroller.scrollTop
    );
    if (!geom) return;

    for (const slot of tableGutterSlots(geom, { row: hoverRow, col: hoverCol })) {
      const isRail = slot.kind === 'col-append' || slot.kind === 'row-append';
      const el = document.createElement(isRail ? 'button' : 'div');
      el.className = `${SLOT_CLASS} ${SLOT_CLASS}--${slot.kind}`;
      el.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
      el.style.width = `${slot.width}px`;
      el.style.height = `${slot.height}px`;
      if (el instanceof HTMLButtonElement) {
        el.type = 'button';
        const isCol = slot.kind === 'col-append';
        el.setAttribute('aria-label', isCol ? 'Add column' : 'Add row');
        const index = slot.index;
        // Bound to click, NOT pointerup: WKWebView drops pointerup on a motionless
        // press, and the Chromium latency gate is blind to that difference.
        el.addEventListener('click', (e) => {
          e.preventDefault();
          if (isCol) blockSurface.insertTableColumnAt(blockId, index, 0);
          else blockSurface.insertTableRowAt(blockId, index, 0);
        });
        // Keep a press on the chrome from stealing the caret out of the cell
        // before the op runs.
        el.addEventListener('mousedown', (e) => e.preventDefault());
      }
      layer.appendChild(el);
    }
  };

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
    if (!table) {
      clear();
      return;
    }
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
  // an append rail: keep the table but drop the contextual handles. In the grace
  // zone (handle lane or rail gap, which hit-test to no cell): hold as-is. Only
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
      cancelHide(); // over an append rail: no cell, so no handles
      setState(active, null, null);
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
    if (active) schedule();
  };

  // A structural pass rebuilds block elements wholesale (replaceWith), so every
  // measured rect is stale afterwards. This is the same signal the decoration
  // overlay and the code-highlight mirrors ride, and it is provably off the
  // keystroke path.
  const unsubscribe = blockSurface.onStructureChange(() => {
    // The element identity changed; re-resolve the active table by block id. A
    // structural op can change the row/column count (a just-appended column shifts
    // the counts), so clamp the hovered coordinates against the fresh geometry
    // rather than trust the pre-op indices.
    if (!active) return;
    const blockId = active.getAttribute(BLOCK_ID_ATTR);
    active = blockId
      ? surface.querySelector<HTMLTableElement>(`table[${BLOCK_ID_ATTR}="${blockId}"]`)
      : null;
    if (!active) {
      setState(null, null, null);
      return;
    }
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
      scroller.removeEventListener('pointerover', onPointerOver);
      scroller.removeEventListener('pointerleave', onPointerLeave);
      surface.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('resize', onReflow);
      resizeObserver?.disconnect();
      if (scheduled) cancelAnimationFrame(rafId);
      cancelHide();
      active = null;
      clear();
    }
  };
}
