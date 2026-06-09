// Live dirty-tracking: when the user edits, mark exactly and only the top-level
// blocks whose content actually changed. A clean block then serializes from its
// verbatim `src`; a dirty block re-serializes canonically.
//
// Implementation: an appendTransaction that, for every document-changing
// transaction, collects the changed ranges in final-document coordinates and
// sets `dirty: true` on each top-level block that overlaps one. Each step's
// changed range is reported in the coordinate space *after that step*, so we map
// it forward through the remaining steps (the standard ProseMirror pattern) to
// land it in the final doc.
//
// Two kinds of step contribute a range:
//   - Position-changing steps (Replace/ReplaceAround) report their changed range
//     through their StepMap.
//   - Mark steps (AddMark/RemoveMark) change content without moving any position,
//     so their StepMap is EMPTY — `map.forEach` yields nothing. Their affected
//     span lives on the step's own `from`/`to`. Without handling these
//     explicitly, applying a mark (⌘B, the toolbar, the bubble) would dirty no
//     block, and the edit would serialize away from the verbatim `src` — i.e.
//     bold/italic/code/link toggles would silently fail to persist.
//
// This plugin also owns a second post-edit invariant: NO BLOCK MAY INHERIT
// CAPTURED ATTRS IT WAS NOT PARSED WITH. ProseMirror's split machinery
// (splitBlock on Enter, splitListItem, input rules, paste) copies the split
// node's attrs onto the second half — including our `src` and `gapBefore`.
// gapForSeam treats any captured (non-null) gapBefore as authoritative, so a
// split of the FIRST block (gapBefore '') produces a second half whose seam
// serializes to '' — the user's paragraph break silently vanishes from the
// file. (For non-first blocks the inherited '\n\n' happens to coincide with
// the canonical separator, but the inherited `src` is still a lie about the
// block's origin.) The fix lives here rather than in custom split commands
// because every split path — keymap, input rule, paste, programmatic — funnels
// through this appendTransaction, and the attr reset joins the same history
// event as the split itself, so undo stays coherent.
//
// Detection: a block in the final doc legitimately carries captured attrs only
// if it IS one of the previous doc's top-level blocks — i.e. its start position
// is the image of some old block's start under the batch's full mapping. A
// block that merely moved (an edit above it) maps cleanly and is left alone; a
// split's second half (or a pasted duplicate of a captured block) starts at a
// position no old block start maps to, so its `src`/`gapBefore` are reset to
// null and it serializes canonically (a null-src block always does — the
// idempotence guard never fires without `src`). Undo/redo transactions are
// exempt: prosemirror-history legitimately re-inserts captured blocks whose
// positions have no preimage in the adjacent state, and history must restore
// attrs byte-exactly, not have them re-derived.
//
// Frozen blocks have no `dirty` attribute and are skipped by both passes: they
// are always emitted verbatim and must never be canonicalized.

import { Plugin } from 'prosemirror-state';
import { Mapping, AddMarkStep, RemoveMarkStep, type StepMap, type Step } from 'prosemirror-transform';
import type { Transaction, EditorState } from 'prosemirror-state';
import type { Attrs } from 'prosemirror-model';

const SKIP = 'pm-projection-dirty-skip';
// prosemirror-history tags its undo/redo transactions with its PluginKey,
// whose generated name is "history$". Reading it by name avoids importing the
// (non-exported) key object; this is the established PM idiom for the check.
const HISTORY_META = 'history$';

function changedRangesInFinalDoc(steps: Step[], maps: StepMap[], full: Mapping): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < steps.length; i++) {
    const rest = full.slice(i + 1);
    const map = maps[i];
    map?.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
    });
    // Mark steps carry their span on from/to; map it forward like any range.
    const step = steps[i];
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      ranges.push([rest.map(step.from, -1), rest.map(step.to, 1)]);
    }
  }
  return ranges;
}

export const dirtyPlugin = new Plugin({
  appendTransaction(trs, oldState: EditorState, newState: EditorState) {
    if (!trs.some((tr) => tr.docChanged)) return null;
    if (trs.some((tr) => tr.getMeta(SKIP))) return null;

    // Steps and their maps are index-aligned within a transaction (one map per
    // step), and we concatenate both in the same order, so the alignment holds
    // across the whole batch.
    const steps: Step[] = [];
    const maps: StepMap[] = [];
    for (const tr of trs) {
      steps.push(...tr.steps);
      maps.push(...tr.mapping.maps);
    }
    const full = new Mapping(maps);

    const ranges = changedRangesInFinalDoc(steps, maps, full);
    if (!ranges.length) return null;

    // Where the previous doc's top-level blocks landed in the final doc. A new
    // block carrying captured attrs at any OTHER position was manufactured by
    // this batch (split second-half, pasted duplicate) and gets reset below.
    // assoc 1 so a block start that coincides with an insertion point follows
    // its block (e.g. insertDivider inserting a rule directly before it).
    const isHistory = trs.some((tr) => tr.getMeta(HISTORY_META));
    const legitimateStarts = new Set<number>();
    if (!isHistory) {
      oldState.doc.forEach((_block, offset) => {
        legitimateStarts.add(full.map(offset, 1));
      });
    }

    const tr = newState.tr.setMeta(SKIP, true);
    let modified = false;
    newState.doc.forEach((block, offset) => {
      if (!('dirty' in block.attrs)) return; // frozen blocks never go dirty
      let attrs: Attrs = block.attrs;

      // Pass 1 — captured-attr provenance. Reset inherited `src`/`gapBefore`
      // on blocks this batch manufactured; dirty:true matches the precedent in
      // commands.ts (list-type switch) and is anyway irrelevant once src is
      // null — the block serializes canonically either way.
      if (
        !isHistory &&
        !legitimateStarts.has(offset) &&
        (attrs.src != null || attrs.gapBefore != null)
      ) {
        attrs = { ...attrs, src: null, gapBefore: null, dirty: true };
      }

      // Pass 2 — content dirtying by changed-range overlap.
      if (!attrs.dirty) {
        const from = offset;
        const to = offset + block.nodeSize;
        if (ranges.some(([cs, ce]) => cs < to && ce > from)) {
          attrs = { ...attrs, dirty: true };
        }
      }

      if (attrs !== block.attrs) {
        tr.setNodeMarkup(offset, undefined, attrs);
        modified = true;
      }
    });
    return modified ? tr : null;
  }
});
