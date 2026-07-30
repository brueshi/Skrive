// Geometry for the per-block hover chrome. Like the table chrome's, these
// exercise the pure slot/zone arithmetic directly: it operates on an
// already-measured shape, so it verifies without layout (jsdom implements no box
// geometry).

import { describe, expect, it } from 'vitest';
import {
  BLOCK_CHROME_METRICS as M,
  blockChromeSlots,
  blockHoverZone,
  type BlockGeometry,
  type BlockSlot
} from '../../src/lib/blocksurface/block-chrome';
import { zoneContains } from '../../src/lib/blocksurface/table-chrome';

/** A block at (100, 200), 400 wide, `lines` lines of 20px. */
function geometry(lines = 1): BlockGeometry {
  return {
    box: { x: 100, y: 200, width: 400, height: lines * 20 },
    firstLineHeight: 20
  };
}

const byKind = (slots: BlockSlot[], kind: BlockSlot['kind']): BlockSlot => {
  const hit = slots.find((s) => s.kind === kind);
  if (!hit) throw new Error(`no ${kind} slot`);
  return hit;
};

describe('blockChromeSlots', () => {
  it('emits exactly a grip and an insert', () => {
    const slots = blockChromeSlots(geometry());
    expect(slots.map((s) => s.kind)).toEqual(['insert', 'grip']);
  });

  it('places the grip in the left gutter, outside the block', () => {
    const grip = byKind(blockChromeSlots(geometry()), 'grip');
    expect(grip.x + grip.width, 'grip ends before the block starts').toBeLessThanOrEqual(100);
    expect(grip.x).toBe(100 - M.gripGap - M.gripWidth);
    expect(grip.width).toBe(M.gripWidth);
    expect(grip.height).toBe(M.gripHeight);
  });

  it('places the insert outboard of the grip, not overlapping it', () => {
    const slots = blockChromeSlots(geometry());
    const grip = byKind(slots, 'grip');
    const insert = byKind(slots, 'insert');
    expect(insert.x + insert.width, 'insert ends before the grip starts').toBeLessThanOrEqual(grip.x);
    expect(grip.x - (insert.x + insert.width)).toBe(M.plusGap);
  });

  it('centres both slots on the first line, not on the block', () => {
    // The whole point: a twenty-line paragraph carries its grip beside its FIRST
    // line, where the writer is looking, not floating halfway down the block.
    const short = blockChromeSlots(geometry(1));
    const tall = blockChromeSlots(geometry(20));
    expect(byKind(tall, 'grip').y, 'grip does not drift down a long block').toBe(byKind(short, 'grip').y);
    expect(byKind(tall, 'insert').y).toBe(byKind(short, 'insert').y);

    const firstLineMid = 200 + 20 / 2;
    expect(byKind(short, 'grip').y + M.gripHeight / 2).toBe(firstLineMid);
    expect(byKind(short, 'insert').y + M.plusSize / 2).toBe(firstLineMid);
  });

  it('does not collapse the chrome on a block that measures shorter than a line', () => {
    // An empty paragraph can measure near-zero; the grip still needs somewhere to sit.
    const slots = blockChromeSlots({ box: { x: 100, y: 200, width: 400, height: 0 }, firstLineHeight: 0 });
    const grip = byKind(slots, 'grip');
    expect(grip.height).toBe(M.gripHeight);
    expect(grip.y + M.gripHeight / 2, 'centred on the minimum line').toBe(200 + M.minLineHeight / 2);
  });

  it('shifts the cluster on canvas rather than off the left edge in a narrow window', () => {
    // A block starting at x=6 leaves nowhere for a 37px gutter; the cluster
    // slides right instead of rendering where nothing can be seen or clicked.
    const slots = blockChromeSlots({ box: { x: 6, y: 200, width: 200, height: 20 }, firstLineHeight: 20 });
    const insert = byKind(slots, 'insert');
    const grip = byKind(slots, 'grip');
    expect(insert.x, 'never off canvas').toBe(0);
    expect(grip.x, 'spacing between the two is preserved').toBe(M.plusSize + M.plusGap);
  });

  it('tracks the block horizontally', () => {
    const moved = blockChromeSlots({ box: { x: 340, y: 200, width: 400, height: 20 }, firstLineHeight: 20 });
    expect(byKind(moved, 'grip').x).toBe(340 - M.gripGap - M.gripWidth);
  });
});

describe('blockHoverZone', () => {
  const rect = { left: 100, top: 200, right: 500, bottom: 260 };

  it('reaches left far enough to cover the whole gutter', () => {
    // The outermost affordance must sit inside the zone, or moving onto it to
    // click would dismiss the chrome being reached for. Expressed in metrics
    // rather than against a slot: slots are in the scroller's CONTENT space and
    // the zone is in viewport space, so comparing the two directly would only
    // work by fixture coincidence.
    const zone = blockHoverZone(rect);
    const gutterReach = M.gripGap + M.gripWidth + M.plusGap + M.plusSize;
    expect(zoneContains(zone, rect.left - gutterReach, rect.top + 10), 'outer edge of the +').toBe(true);
    expect(zone.left).toBeLessThan(rect.left - gutterReach);
  });

  it('holds the pointer in the gap between the block and the grip', () => {
    const zone = blockHoverZone(rect);
    // Mid-gutter: hit-tests to no block, so without the zone the chrome would
    // start fading exactly as the pointer crossed toward it.
    expect(zoneContains(zone, 100 - M.gripGap / 2, 230)).toBe(true);
  });

  it('grows the block box on every side', () => {
    const zone = blockHoverZone(rect);
    expect(zone.top).toBeLessThan(rect.top);
    expect(zone.bottom).toBeGreaterThan(rect.bottom);
    expect(zone.right).toBeGreaterThan(rect.right);
  });

  it('excludes a pointer well away from the block', () => {
    const zone = blockHoverZone(rect);
    expect(zoneContains(zone, 100, 600), 'far below').toBe(false);
    expect(zoneContains(zone, 0, 230), 'far left of the gutter').toBe(false);
  });
});
