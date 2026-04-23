// Scroll-sync utilities for the diff view. Two modes, per the Phase
// 3.3 UI memo:
//
//   - **Linear.** Scroll-height ratio between the two panes. Simple,
//     cheap, DOM-free. Works identically in raw and preview modes.
//     The raw pane already renders one row per line-diff entry with
//     placeholder rows on the opposite pane, so linear sync gives a
//     pixel-exact row-for-row alignment there.
//
//   - **Matched.** Segment-aligned sync for preview mode. Each pane
//     tags its rendered diff segments with `data-diff-seg-index={i}`;
//     the same index on both panes identifies the same source
//     segment. At scroll time we find which segment the source pane
//     is inside, compute "progress within segment" (0..1), and apply
//     the same progress to the target pane's matching segment. Short
//     placeholders line up at their tops with tall replacement blocks;
//     the middle interpolates.
//
// No Svelte dependencies — callable from any surface that has DOM
// refs to the two scrolling pane bodies.

/** Geometry for a single segment inside one pane's scroll container. */
export type SegMetric = { index: number; top: number; height: number };

/**
 * Read offsetTop / offsetHeight for every element in `paneBody` that
 * carries a `data-diff-seg-index` attribute. Cheap — one layout read
 * per rendered segment. Call after the layout settles; on resize or
 * content change re-measure before syncing.
 */
export function measurePaneSegments(paneBody: HTMLElement): SegMetric[] {
  const out: SegMetric[] = [];
  const nodes = paneBody.querySelectorAll<HTMLElement>(
    "[data-diff-seg-index]",
  );
  nodes.forEach((el) => {
    const raw = el.dataset.diffSegIndex;
    if (raw === undefined) return;
    const index = Number(raw);
    if (!Number.isFinite(index)) return;
    out.push({
      index,
      top: el.offsetTop,
      height: el.offsetHeight,
    });
  });
  return out;
}

/**
 * Map a `scrollTop` on the source pane to the matched `scrollTop`
 * on the target pane. Finds the source segment whose vertical range
 * contains `fromScrollTop`, then maps the within-segment progress
 * onto the same-indexed segment on the target pane.
 *
 * Edge cases handled per the memo:
 *   - Scroll position above all segments → 0.
 *   - Scroll position past the last segment with a matched pair →
 *     fall back to linear (ratio) sync for the tail.
 *   - An index that exists on one pane but not the other → ratio
 *     fallback for that moment.
 *   - Zero-height segments (empty rows) → no divide-by-zero; treated
 *     as progress = 0.
 */
export function matchedScrollTop(
  fromScrollTop: number,
  fromSegs: SegMetric[],
  toSegs: SegMetric[],
  fromScrollHeight: number,
  toScrollHeight: number,
): number {
  if (fromSegs.length === 0 || toSegs.length === 0) {
    return linearScrollTop(fromScrollTop, fromScrollHeight, toScrollHeight);
  }
  // Source segment: the first whose range contains fromScrollTop.
  // If scroll is at the very top we return the first seg's to-top
  // directly; if past the last, we ratio-fall-back.
  let source: SegMetric | null = null;
  for (const seg of fromSegs) {
    if (fromScrollTop < seg.top + seg.height) {
      source = seg;
      break;
    }
  }
  if (!source) {
    return linearScrollTop(fromScrollTop, fromScrollHeight, toScrollHeight);
  }
  const target = toSegs.find((s) => s.index === source!.index);
  if (!target) {
    return linearScrollTop(fromScrollTop, fromScrollHeight, toScrollHeight);
  }
  const progress =
    source.height > 0
      ? Math.max(0, fromScrollTop - source.top) / source.height
      : 0;
  return target.top + progress * target.height;
}

/**
 * Proportional scroll-height sync. When scroll heights differ (common
 * in preview mode because blocks render differently, rare in raw mode
 * where placeholders equalize), this maps the source's scroll fraction
 * onto the target's scrollable range.
 */
export function linearScrollTop(
  fromScrollTop: number,
  fromScrollHeight: number,
  toScrollHeight: number,
): number {
  if (fromScrollHeight <= 0) return 0;
  return (fromScrollTop / fromScrollHeight) * toScrollHeight;
}

/**
 * Given an ordered list of change-segment indices (segments where
 * `kind === "change"`) and the source pane's scroll position + its
 * segment metrics, return the index (within the changes list) of the
 * change the user is currently "on."
 *
 * Definition: the change whose segment top is ≤ viewport top + a
 * small epsilon, and whose bottom is > viewport top. If no change is
 * currently under the viewport top, return -1 — the UI renders that
 * as "0 of N".
 */
export function currentChangeIndex(
  scrollTop: number,
  segMetrics: SegMetric[],
  changeIndices: number[],
): number {
  if (changeIndices.length === 0) return -1;
  // Rounding tolerance for "viewport top sits exactly on a boundary".
  const epsilon = 2;
  let hit = -1;
  for (let i = 0; i < changeIndices.length; i++) {
    const segIndex = changeIndices[i];
    const seg = segMetrics.find((m) => m.index === segIndex);
    if (!seg) continue;
    if (scrollTop + epsilon >= seg.top) {
      hit = i;
    } else {
      break;
    }
  }
  return hit;
}

/**
 * Next-change target: the first change segment whose top is strictly
 * past `scrollTop`. Returns the segment's top scroll position, or
 * `null` when no more changes lie ahead.
 */
export function nextChangeTop(
  scrollTop: number,
  segMetrics: SegMetric[],
  changeIndices: number[],
): number | null {
  // Small epsilon so holding `n` down doesn't re-snap to the same
  // segment from a fractional-pixel scroll position.
  const epsilon = 2;
  for (const changeIdx of changeIndices) {
    const seg = segMetrics.find((m) => m.index === changeIdx);
    if (!seg) continue;
    if (seg.top > scrollTop + epsilon) return seg.top;
  }
  return null;
}

/**
 * Previous-change target: the last change segment whose top is
 * strictly before `scrollTop`. Returns the segment's top scroll
 * position, or `null` when already above every change.
 */
export function prevChangeTop(
  scrollTop: number,
  segMetrics: SegMetric[],
  changeIndices: number[],
): number | null {
  const epsilon = 2;
  let prev: number | null = null;
  for (const changeIdx of changeIndices) {
    const seg = segMetrics.find((m) => m.index === changeIdx);
    if (!seg) continue;
    if (seg.top < scrollTop - epsilon) prev = seg.top;
    else break;
  }
  return prev;
}
