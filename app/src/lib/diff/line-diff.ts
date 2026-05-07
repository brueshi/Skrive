// Renderer-side wrapper around the line diff IPC. Walks
// `similar::TextDiff` line-by-line and emits a flat row sequence the
// raw-diff renderer consumes one-for-one across both panes.
//
// Shape mirrors `native/diff/src/diff.rs::LineDiffRow`. The `kind`
// discriminator is redundant with the presence of `before` / `after`
// (kept ⇔ both, added ⇔ before null, deleted ⇔ after null) but
// carrying it explicitly keeps the render-side code one-pass-friendly.

export type { LineDiffRow, LineKind } from '@skrive/shared';

import type { LineDiffRow } from '@skrive/shared';

/**
 * Compute the side-by-side line diff of two source strings. Pure
 * computation — see `computeDiff` for the structural counterpart.
 */
export async function computeLineDiff(
  before: string,
  after: string
): Promise<LineDiffRow[]> {
  return window.skrive.diff.computeLineDiff(before, after);
}
