// Thin wrapper around the Rust `compute_line_diff` command. Called
// from the project store when the user enters diff mode so `DiffView`
// gets a ready-to-render row sequence instead of re-running the
// diff on every rerender.
//
// Shape mirrors `src-tauri/src/diff.rs::LineDiffRow`. The `kind`
// discriminator is redundant with the presence of `before` / `after`
// (kept ⇔ both, added ⇔ before null, deleted ⇔ after null) but
// carrying it explicitly keeps the render-side code one-pass-friendly
// and leaves room for Phase 3.3b's richer ops.

import { invoke } from "@tauri-apps/api/core";

export type LineKind = "kept" | "added" | "deleted";

export type LineDiffRow = {
  kind: LineKind;
  before: string | null;
  after: string | null;
};

/**
 * Compute the side-by-side line diff of two source strings. Pure
 * computation — no project state touched — so callers can invoke it
 * freely without worrying about open-project preconditions.
 */
export async function computeLineDiff(
  before: string,
  after: string,
): Promise<LineDiffRow[]> {
  return invoke<LineDiffRow[]>("compute_line_diff", { before, after });
}
