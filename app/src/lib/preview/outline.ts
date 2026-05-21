// Pure geometry for the preview outline rail. The rail component reads
// heading positions out of the rendered DOM (which is inherently
// imperative and hard to unit-test); everything that can be expressed as
// "given these numbers, which heading is active" lives here so it can be
// pinned with plain tests.

export type OutlineHeading = {
  /** Slug id assigned by the markdown renderer; the scroll target. */
  id: string;
  /** Rendered heading text, for the popover label and tick tooltip. */
  text: string;
  /** 1–6. Drives the tick width and the popover indent. */
  depth: number;
  /** Distance in px from the top of the scroller's content. */
  top: number;
};

/**
 * Index of the heading whose section the viewport is currently inside —
 * the last heading at or above an activation line a little below the
 * scroller's top edge. Returns -1 for an empty list.
 *
 * Two edge cases matter:
 *   - At the very bottom of a scrollable document the last heading can
 *     sit above the activation line yet still be the section you're
 *     reading, so the bottom wins outright.
 *   - A document that doesn't overflow has no meaningful scroll
 *     position; the activation line alone decides, which keeps the first
 *     heading active at rest instead of snapping to the last.
 */
export function activeHeadingIndex(
  tops: readonly number[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  activationOffset = 24
): number {
  if (tops.length === 0) return -1;

  const overflows = scrollHeight > clientHeight + 2;
  if (overflows && scrollTop + clientHeight >= scrollHeight - 2) {
    return tops.length - 1;
  }

  const line = scrollTop + activationOffset;
  let active = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! <= line) active = i;
    else break;
  }
  return active;
}
