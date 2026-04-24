// Thin wrapper around the Rust `compute_diff` command. Phase 3.3b's
// structural diff — block-hash matching with assignment, per
// docs/3.3-algorithm-memo.md's decision. Called alongside the line-
// diff when the user enters diff mode; the two outputs feed different
// renderer paths (line rows drive raw mode, structural ops drive
// preview mode's moved/reworded decorations).
//
// Shape mirrors `src-tauri/src/diff.rs::DiffOp` and its satellites.
// Serde tags each variant with a `kind` discriminator, so the
// discriminated-union narrowing below is direct.

import { invoke } from "@tauri-apps/api/core";

/**
 * Coarse classification of a markdown block for renderer routing.
 * Headings carry their level; other kinds are flat tokens. Mirrors
 * `BlockKind` in `diff.rs`.
 */
export type BlockKind =
  | { kind: "heading"; level: number }
  | { kind: "paragraph" }
  | { kind: "list" }
  | { kind: "codeFence" }
  | { kind: "blockquote" }
  | { kind: "thematicBreak" }
  | { kind: "table" };

/**
 * One top-level block. `source` is the raw markdown string; the
 * renderer passes it through its own `renderMarkdown` helper when
 * drawing preview-mode content. Mirrors `Block` in `diff.rs`.
 */
export type Block = {
  kind: BlockKind;
  source: string;
};

/**
 * One word-level change inside a `Reworded` op. The renderer walks
 * these in order so a reworded paragraph reads as the revised prose,
 * with added phrases tinted and deleted phrases struck through.
 * Mirrors `WordOp` in `diff.rs`.
 */
export type WordOp =
  | { kind: "kept"; text: string }
  | { kind: "added"; text: string }
  | { kind: "deleted"; text: string };

/**
 * Semantic diff operation. Discriminated on `kind`. Every variant
 * carries the before/after position the renderer needs to compose
 * its two-pane layout. Mirrors `DiffOp` in `diff.rs`.
 */
export type DiffOp =
  | {
      kind: "kept";
      beforeIndex: number;
      afterIndex: number;
      block: Block;
    }
  | {
      kind: "added";
      afterIndex: number;
      block: Block;
    }
  | {
      kind: "deleted";
      beforeIndex: number;
      block: Block;
    }
  | {
      kind: "moved";
      from: number;
      to: number;
      block: Block;
    }
  | {
      kind: "reworded";
      beforeIndex: number;
      afterIndex: number;
      before: Block;
      after: Block;
      score: number;
      wordDiff: WordOp[];
    };

/**
 * Compute the structural diff of two source strings. Pure
 * computation — no project state touched — so callers can invoke it
 * freely without worrying about open-project preconditions.
 */
export async function computeDiff(
  before: string,
  after: string,
): Promise<DiffOp[]> {
  return invoke<DiffOp[]>("compute_diff", { before, after });
}
