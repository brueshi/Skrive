// Pure geometry for the table chrome: slot arithmetic over an already-measured
// table, the resize trade, and drop targets. No DOM, no measurement, so all of
// it verifies without layout. Measurement itself stays with the host until the
// chrome relocates.

import type { TableGeometry } from './contract';

export type { TableGeometry } from './contract';

/** One painted affordance. `index` is a model coordinate, not a pixel one. */
export type GutterSlot = {
  kind: 'col-handle' | 'row-handle' | 'col-append' | 'row-append' | 'col-resize';
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Which row and column the pointer is over; null when over neither. */
export type HoverCell = { row: number | null; col: number | null };

/** Chrome sizing. Overlay-only: reserves no layout space. */
export const GUTTER_METRICS = {
  /** Short dimension of a row/column handle bar. */
  handleThickness: 6,
  /** Gap between a handle and the table's edge. */
  handleGap: 5,
  /** Inset at each end of a handle. */
  handleInset: 8,
  /** Short dimension of an append rail. */
  railThickness: 16,
  /** Gap between an append rail and the table's edge. */
  railGap: 4,
  /** Width of the grab strip on an interior column boundary. */
  resizeGrab: 9
} as const;

export type GutterMetrics = typeof GUTTER_METRICS;

/** Grace margin, in px, around the chrome that still counts as hovering. */
export const ZONE_SLACK = 10;

/**
 * The slots for a measured table: two append rails that always show while the
 * table is active, plus a handle above the hovered column and left of the
 * hovered row. The rails append at `cols` / `rows`; mid-table insertion is the
 * menu's and the chords' job.
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

  slots.push({
    kind: 'col-append',
    index: cols,
    x: box.x + box.width + m.railGap,
    y: box.y,
    width: m.railThickness,
    height: box.height
  });

  slots.push({
    kind: 'row-append',
    index: rows,
    x: box.x,
    y: box.y + box.height + m.railGap,
    width: box.width,
    height: m.railThickness
  });

  if (hover.col !== null) {
    const s = tableHandleSlot(geom, 'col', hover.col, m);
    if (s) slots.push(s);
  }
  if (hover.row !== null) {
    const s = tableHandleSlot(geom, 'row', hover.row, m);
    if (s) slots.push(s);
  }

  return slots;
}

/** The handle bar for one row or column; null when `index` is out of range. */
export function tableHandleSlot(
  geom: TableGeometry,
  kind: 'row' | 'col',
  index: number,
  m: GutterMetrics = GUTTER_METRICS
): GutterSlot | null {
  const { box, colEdges, rowEdges } = geom;
  if (kind === 'col') {
    const cols = colEdges.length - 1;
    if (index < 0 || index >= cols) return null;
    const left = colEdges[index]!;
    const width = colEdges[index + 1]! - left;
    return {
      kind: 'col-handle',
      index,
      x: left + m.handleInset,
      y: box.y - m.handleGap - m.handleThickness,
      width: Math.max(width - 2 * m.handleInset, m.handleThickness),
      height: m.handleThickness
    };
  }
  const rows = rowEdges.length - 1;
  if (index < 0 || index >= rows) return null;
  const top = rowEdges[index]!;
  const height = rowEdges[index + 1]! - top;
  return {
    kind: 'row-handle',
    index,
    x: box.x - m.handleGap - m.handleThickness,
    y: top + m.handleInset,
    width: m.handleThickness,
    height: Math.max(height - 2 * m.handleInset, m.handleThickness)
  };
}

/**
 * A grab strip centered on every interior column boundary. A slot's `index` is
 * the left column of the pair the drag trades between. Fewer than two columns
 * yields none.
 */
export function tableResizeSlots(geom: TableGeometry, m: GutterMetrics = GUTTER_METRICS): GutterSlot[] {
  const { box, colEdges } = geom;
  const cols = colEdges.length - 1;
  if (cols < 2) return [];
  const slots: GutterSlot[] = [];
  for (let i = 0; i < cols - 1; i++) {
    const edge = colEdges[i + 1]!;
    slots.push({
      kind: 'col-resize',
      index: i,
      x: edge - m.resizeGrab / 2,
      y: box.y,
      width: m.resizeGrab,
      height: box.height
    });
  }
  return slots;
}

/**
 * Trade width between column `boundary` and its right neighbor by `deltaPx`,
 * clamped so neither falls below `minPx`. The pair's total is conserved, so the
 * table never grows. An out-of-range boundary yields an unchanged copy.
 */
export function resizeColumnWidths(
  widths: readonly number[],
  boundary: number,
  deltaPx: number,
  minPx: number
): number[] {
  const next = widths.slice();
  const i = boundary;
  const j = boundary + 1;
  if (i < 0 || j >= widths.length) return next;
  const a = widths[i]!;
  const b = widths[j]!;
  if (a <= minPx && b <= minPx) return next;
  const delta = Math.max(-(a - minPx), Math.min(deltaPx, b - minPx));
  next[i] = a + delta;
  next[j] = b - delta;
  return next;
}

/**
 * Normalize pixel widths to fractional weights summing to about 1, rounded to
 * 4 decimals so an identical drag commits an identical array. An all-zero
 * input falls back to equal weights.
 */
export function normalizeWidths(widths: readonly number[]): number[] {
  let total = 0;
  for (const w of widths) if (w > 0) total += w;
  if (total <= 0) {
    const equal = widths.length ? 1 / widths.length : 1;
    return widths.map(() => equal);
  }
  return widths.map((w) => Math.round(((w > 0 ? w : 0) / total) * 1e4) / 1e4);
}

/** The index of the edge nearest `pos`; ties go to the lower index. */
export function nearestBoundary(edges: readonly number[], pos: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < edges.length; i++) {
    const d = Math.abs(edges[i]! - pos);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** A drop-indicator line at a boundary, spanning the table's cross axis. */
export type DropIndicator = { x: number; y: number; width: number; height: number };
export function dropIndicatorRect(
  geom: TableGeometry,
  kind: 'row' | 'col',
  boundary: number,
  thickness = 2
): DropIndicator {
  const { box, colEdges, rowEdges } = geom;
  if (kind === 'col') {
    const i = Math.max(0, Math.min(boundary, colEdges.length - 1));
    return { x: colEdges[i]! - thickness / 2, y: box.y, width: thickness, height: box.height };
  }
  const i = Math.max(0, Math.min(boundary, rowEdges.length - 1));
  return { x: box.x, y: rowEdges[i]! - thickness / 2, width: box.width, height: thickness };
}

/** A rectangle in whatever space the caller measured in. */
export type HoverZone = { left: number; top: number; right: number; bottom: number };

/**
 * The pointer zone a table owns: its rect grown to cover the handle lanes (top
 * and left) and the append rails (right and bottom), plus slack. Inside it the
 * chrome stays up.
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
