// Pure geometry for the preview outline rail. The rail component reads
// heading positions out of the rendered DOM (which is inherently
// imperative and hard to unit-test); everything that can be expressed as
// "given these numbers, which heading is active" lives here so it can be
// pinned with plain tests.

export type OutlineHeading = {
  /**
   * Stable identity for this heading, surviving edits and reordering: the
   * block id on the rich surface, the slug id in the rendered preview.
   * Fold state keys on it, so it must not be the array index — folding a
   * section and then typing a heading above it would otherwise move the
   * fold onto a different section.
   */
  key: string;
  /** Rendered heading text, for the popover label and tick tooltip. */
  text: string;
  /** 1–6. Drives the tick indent and the popover indent. */
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

// ----- Section nesting -----
//
// A heading list is flat; the tree is implied by the depths. A heading's
// section runs to the next heading at the same depth or shallower, so its
// descendants are the run of strictly-deeper headings that follow it.
//
// This tolerates skipped levels (an h1 followed directly by an h3) and
// documents that start deep or rise back above their opening level,
// because it only ever compares depths — it never assumes a well-formed
// h1 -> h2 -> h3 ladder, which real documents routinely violate.

/**
 * Index one past the last descendant of the heading at `index` — i.e. the
 * end of its section, exclusive. A heading with no children returns
 * `index + 1`, so the result is always a valid slice end.
 */
export function sectionEnd(depths: readonly number[], index: number): number {
  const own = depths[index];
  if (own === undefined) return index + 1;
  let end = index + 1;
  while (end < depths.length && depths[end]! > own) end++;
  return end;
}

/** Whether the heading at `index` has any nested headings under it. */
export function hasChildren(depths: readonly number[], index: number): boolean {
  return sectionEnd(depths, index) > index + 1;
}

/**
 * The heading indices that remain on screen once `folded` sections are
 * collapsed, in document order. A folded heading is itself visible — it is
 * the row you click to unfold — while its whole section is skipped, so
 * folds nested inside a folded section collapse with it and need no
 * special handling.
 *
 * `folded` holds indices, not keys: identity is the component's business
 * (it maps its stable keys onto the current list), and keeping this
 * numeric is what lets the nesting rules be tested as plain arithmetic.
 */
export function visibleIndices(
  depths: readonly number[],
  folded: ReadonlySet<number>
): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < depths.length) {
    out.push(i);
    i = folded.has(i) ? sectionEnd(depths, i) : i + 1;
  }
  return out;
}

/**
 * The row standing in for `index` when it is hidden inside a folded
 * section: the nearest visible heading at or before it, which is the head
 * of the fold that swallowed it. Used to keep the "you are here" mark on
 * screen when the reader scrolls into a collapsed section.
 *
 * Walking backwards is sufficient because every heading hidden by a fold
 * lies after that fold's visible head with nothing visible in between.
 * Returns -1 when nothing qualifies (an empty list, or `index` of -1).
 */
export function nearestVisible(
  index: number,
  visible: ReadonlySet<number>
): number {
  for (let i = index; i >= 0; i--) {
    if (visible.has(i)) return i;
  }
  return -1;
}
