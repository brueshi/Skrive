// Geometry for the table hover chrome. These exercise the pure slot/zone
// arithmetic directly: it operates on an already-measured shape, so it verifies
// without layout (jsdom implements no box geometry, which is the same reason
// decoration-overlay's contentBox is exported and tested this way).

import { describe, expect, it } from 'vitest';
import {
  GUTTER_METRICS,
  hoverZone,
  normalizeWidths,
  resizeColumnWidths,
  tableGutterSlots,
  tableHandleSlot,
  tableResizeSlots,
  zoneContains,
  type GutterSlot,
  type HoverCell,
  type TableGeometry
} from '../../src/lib/blocksurface/table-chrome';

/** A 3-column, 3-row table at (100, 200), each column 60 wide, each row 20 tall. */
function geometry(cols = 3, rows = 3): TableGeometry {
  const x = 100;
  const y = 200;
  const colWidth = 60;
  const rowHeight = 20;
  return {
    box: { x, y, width: cols * colWidth, height: rows * rowHeight },
    colEdges: Array.from({ length: cols + 1 }, (_, c) => x + c * colWidth),
    rowEdges: Array.from({ length: rows + 1 }, (_, r) => y + r * rowHeight)
  };
}

const NONE: HoverCell = { row: null, col: null };
const one = (slots: GutterSlot[], kind: string): GutterSlot | undefined =>
  slots.find((s) => s.kind === kind);

describe('tableGutterSlots', () => {
  it('always shows the two append rails while a table is active', () => {
    const slots = tableGutterSlots(geometry(3, 3), NONE);
    // With no hovered cell, only the rails — no contextual handles.
    expect(slots.map((s) => s.kind).sort()).toEqual(['col-append', 'row-append']);
  });

  it('runs the column-append rail down the full right edge, appending at col count', () => {
    const rail = one(tableGutterSlots(geometry(3, 3), NONE), 'col-append')!;
    const { railGap, railThickness } = GUTTER_METRICS;
    expect(rail.index).toBe(3); // insert AT the column count == append
    expect(rail.x).toBe(100 + 180 + railGap); // just past the right edge
    expect(rail.y).toBe(200); // table top
    expect(rail.height).toBe(60); // full table height
    expect(rail.width).toBe(railThickness);
  });

  it('runs the row-append rail along the full bottom edge, appending at row count', () => {
    const rail = one(tableGutterSlots(geometry(3, 3), NONE), 'row-append')!;
    const { railGap, railThickness } = GUTTER_METRICS;
    expect(rail.index).toBe(3);
    expect(rail.x).toBe(100); // table left
    expect(rail.y).toBe(200 + 60 + railGap); // just below the bottom edge
    expect(rail.width).toBe(180); // full table width
    expect(rail.height).toBe(railThickness);
  });

  it('shows a column handle above the hovered column only', () => {
    const slots = tableGutterSlots(geometry(3, 3), { row: null, col: 1 });
    const handle = one(slots, 'col-handle')!;
    expect(handle.index).toBe(1);
    // Spans the column inset from both ends.
    const { handleInset, handleGap, handleThickness } = GUTTER_METRICS;
    expect(handle.x).toBe(160 + handleInset); // column 1 starts at x=160
    expect(handle.width).toBe(60 - 2 * handleInset);
    expect(handle.y).toBe(200 - handleGap - handleThickness); // above the header
    expect(handle.height).toBe(handleThickness);
    // No row handle when only a column is hovered.
    expect(one(slots, 'row-handle')).toBeUndefined();
  });

  it('shows a row handle left of the hovered row only', () => {
    // A taller row than the shared helper, so the inset math shows without the
    // narrow-cell clamp (covered on its own below) masking it.
    const geom: TableGeometry = {
      box: { x: 100, y: 200, width: 180, height: 120 },
      colEdges: [100, 160, 220, 280],
      rowEdges: [200, 240, 280, 320]
    };
    const slots = tableGutterSlots(geom, { row: 2, col: null });
    const handle = one(slots, 'row-handle')!;
    expect(handle.index).toBe(2);
    const { handleInset, handleGap, handleThickness } = GUTTER_METRICS;
    expect(handle.y).toBe(280 + handleInset); // row 2 runs 280..320
    expect(handle.height).toBe(40 - 2 * handleInset);
    expect(handle.x).toBe(100 - handleGap - handleThickness); // left of the table
    expect(handle.width).toBe(handleThickness);
    expect(one(slots, 'col-handle')).toBeUndefined();
  });

  it('shows both handles when a cell is hovered', () => {
    const slots = tableGutterSlots(geometry(3, 3), { row: 1, col: 2 });
    expect(one(slots, 'col-handle')!.index).toBe(2);
    expect(one(slots, 'row-handle')!.index).toBe(1);
    // Four elements total: two handles, two rails — the whole calm set.
    expect(slots).toHaveLength(4);
  });

  it('drops a handle whose index is out of range (stale after a structural op)', () => {
    // A column removed under the pointer can leave hoverCol past the new count;
    // the slot function must simply not draw it rather than read off the end.
    const slots = tableGutterSlots(geometry(2, 2), { row: 5, col: 9 });
    expect(one(slots, 'col-handle')).toBeUndefined();
    expect(one(slots, 'row-handle')).toBeUndefined();
    expect(slots.map((s) => s.kind).sort()).toEqual(['col-append', 'row-append']);
  });

  it('tracks uneven column widths from the measured edges', () => {
    // Column widths are browser-decided from content, never modelled — the handle
    // must follow whatever was measured rather than assume a uniform grid.
    const geom: TableGeometry = {
      box: { x: 0, y: 0, width: 300, height: 40 },
      colEdges: [0, 20, 250, 300],
      rowEdges: [0, 20, 40]
    };
    const { handleInset } = GUTTER_METRICS;
    // Column 1 runs 20..250 (230 wide); the handle spans it inset from both ends.
    const handle = one(tableGutterSlots(geom, { row: null, col: 1 }), 'col-handle')!;
    expect(handle.x).toBe(20 + handleInset);
    expect(handle.width).toBe(230 - 2 * handleInset);
  });

  it('never lets a narrow cell collapse its handle below the bar thickness', () => {
    // A cell narrower than 2*inset would give a negative span; clamp to thickness.
    const geom: TableGeometry = {
      box: { x: 0, y: 0, width: 10, height: 8 },
      colEdges: [0, 10],
      rowEdges: [0, 8]
    };
    const { handleThickness } = GUTTER_METRICS;
    const col = one(tableGutterSlots(geom, { row: null, col: 0 }), 'col-handle')!;
    const row = one(tableGutterSlots(geom, { row: 0, col: null }), 'row-handle')!;
    expect(col.width).toBe(handleThickness);
    expect(row.height).toBe(handleThickness);
  });

  it('emits nothing for a degenerate table', () => {
    const empty: TableGeometry = { box: { x: 0, y: 0, width: 0, height: 0 }, colEdges: [0], rowEdges: [0] };
    expect(tableGutterSlots(empty, NONE)).toEqual([]);
  });
});

describe('tableHandleSlot', () => {
  it('matches the hover handle a full slot list would emit', () => {
    // The persistent selected handle must sit exactly where the hover handle does,
    // so selecting a column a user is hovering doesn't shift its bar.
    const geom = geometry(3, 3);
    const fromList = tableGutterSlots(geom, { row: null, col: 2 }).find((s) => s.kind === 'col-handle');
    expect(tableHandleSlot(geom, 'col', 2)).toEqual(fromList);
  });

  it('returns null for an out-of-range index', () => {
    const geom = geometry(3, 3);
    expect(tableHandleSlot(geom, 'col', 3)).toBeNull();
    expect(tableHandleSlot(geom, 'col', -1)).toBeNull();
    expect(tableHandleSlot(geom, 'row', 9)).toBeNull();
  });
});

describe('tableResizeSlots', () => {
  it('places a strip on each interior column boundary, centred on the edge', () => {
    // A 3-column table has two interior boundaries (at colEdges[1] and colEdges[2]).
    const slots = tableResizeSlots(geometry(3, 3));
    const { resizeGrab } = GUTTER_METRICS;
    expect(slots.map((s) => s.kind)).toEqual(['col-resize', 'col-resize']);
    expect(slots.map((s) => s.index)).toEqual([0, 1]); // left column of each boundary
    // colEdges are [100,160,220,280]; boundaries at 160 and 220, strip centred there.
    expect(slots[0]!.x).toBe(160 - resizeGrab / 2);
    expect(slots[1]!.x).toBe(220 - resizeGrab / 2);
    expect(slots[0]!.width).toBe(resizeGrab);
    // Full table height, top-aligned with the table box.
    expect(slots[0]!.y).toBe(200);
    expect(slots[0]!.height).toBe(60);
  });

  it('follows uneven measured column edges rather than a uniform grid', () => {
    const geom: TableGeometry = {
      box: { x: 0, y: 0, width: 300, height: 40 },
      colEdges: [0, 20, 250, 300],
      rowEdges: [0, 20, 40]
    };
    const { resizeGrab } = GUTTER_METRICS;
    const slots = tableResizeSlots(geom);
    expect(slots.map((s) => s.x)).toEqual([20 - resizeGrab / 2, 250 - resizeGrab / 2]);
  });

  it('yields no strips for a single-column table (no boundary to trade across)', () => {
    expect(tableResizeSlots(geometry(1, 3))).toEqual([]);
  });
});

describe('resizeColumnWidths', () => {
  it('trades width between a column and its right neighbour, conserving the pair', () => {
    const next = resizeColumnWidths([100, 100, 100], 0, 30, 40);
    expect(next).toEqual([130, 70, 100]);
    // The untouched column and the pair sum are unchanged (table width is fixed).
    expect(next[0]! + next[1]!).toBe(200);
    expect(next[2]).toBe(100);
  });

  it('clamps so the shrinking neighbour never falls below the minimum', () => {
    // A +80 drag would push column 1 to 20; clamp it to the 40 floor (delta 60).
    expect(resizeColumnWidths([100, 100, 100], 0, 80, 40)).toEqual([160, 40, 100]);
  });

  it('clamps so the dragged column itself never falls below the minimum', () => {
    // A -80 drag would push column 0 to 20; clamp to the 40 floor (delta -60).
    expect(resizeColumnWidths([100, 100, 100], 0, -80, 40)).toEqual([40, 160, 100]);
  });

  it('returns an unchanged copy for an out-of-range boundary', () => {
    const widths = [100, 100];
    expect(resizeColumnWidths(widths, 1, 20, 40)).toEqual([100, 100]); // no column 2
    expect(resizeColumnWidths(widths, -1, 20, 40)).toEqual([100, 100]);
    expect(resizeColumnWidths(widths, 1, 20, 40)).not.toBe(widths); // fresh array
  });
});

describe('normalizeWidths', () => {
  it('turns pixel widths into fractional weights summing to ~1', () => {
    expect(normalizeWidths([150, 50])).toEqual([0.75, 0.25]);
  });

  it('rounds to 4 decimals so an identical drag commits an identical array', () => {
    // Thirds round cleanly and stably rather than trailing float noise.
    expect(normalizeWidths([100, 100, 100])).toEqual([0.3333, 0.3333, 0.3333]);
  });

  it('falls back to equal weights for a degenerate all-zero input', () => {
    expect(normalizeWidths([0, 0])).toEqual([0.5, 0.5]);
  });
});

describe('hoverZone', () => {
  const rect = { left: 100, top: 200, right: 400, bottom: 300 };

  it('grows the top and left edges to cover the handle lanes plus slack', () => {
    // The handles sit above and left of the table, so the zone reaches out past
    // them — that outward reach is what lets the pointer cross from a cell to a
    // handle without dismissing the chrome.
    const zone = hoverZone(rect, GUTTER_METRICS, 10);
    const reach = GUTTER_METRICS.handleGap + GUTTER_METRICS.handleThickness;
    expect(zone.left).toBe(100 - reach - 10);
    expect(zone.top).toBe(200 - reach - 10);
  });

  it('grows the right and bottom edges to cover the append rails plus slack', () => {
    const zone = hoverZone(rect, GUTTER_METRICS, 10);
    const reach = GUTTER_METRICS.railGap + GUTTER_METRICS.railThickness;
    expect(zone.right).toBe(400 + reach + 10);
    expect(zone.bottom).toBe(300 + reach + 10);
  });

  it('keeps a point in the handle lane inside the zone', () => {
    // A point 9px left of the table edge — in the row-handle lane — is the exact
    // case that used to dismiss the chrome.
    const zone = hoverZone(rect);
    expect(zoneContains(zone, 91, 250)).toBe(true);
  });

  it('excludes a point well clear of the table and its chrome', () => {
    const zone = hoverZone(rect);
    expect(zoneContains(zone, 600, 250)).toBe(false);
    expect(zoneContains(zone, 250, 500)).toBe(false);
  });

  it('includes points inside the table itself', () => {
    const zone = hoverZone(rect);
    expect(zoneContains(zone, 250, 250)).toBe(true);
  });
});
