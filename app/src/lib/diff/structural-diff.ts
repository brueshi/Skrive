// Renderer-side wrapper around the structural diff IPC. The Rust core
// in `native/diff/` produces the operations; the shell forwards them
// across IPC; this module re-exports the shared types and offers a
// thin async function that callers (DiffView, the project store) use.
//
// Shape matches `native/diff/src/diff.rs::DiffOp` and is gated by
// `native/diff/__test__/fixtures.test.ts` against the Phase 3.3
// algorithm fixtures. Discriminated on `kind`; narrows directly.

export type {
  Block,
  BlockKind,
  DiffOp,
  WordOp
} from '@skrive/shared';

import type { DiffOp } from '@skrive/shared';

/**
 * Structural diff of two source strings. Pure computation in the main
 * process — no project state touched, no filesystem access — so
 * callers can invoke it freely without open-project preconditions.
 */
export async function computeDiff(
  before: string,
  after: string
): Promise<DiffOp[]> {
  return window.skrive.diff.computeDiff(before, after);
}
