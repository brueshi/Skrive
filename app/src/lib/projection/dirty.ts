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
// Frozen blocks have no `dirty` attribute and are skipped: they are always
// emitted verbatim and must never be canonicalized.

import { Plugin } from 'prosemirror-state';
import { Mapping, AddMarkStep, RemoveMarkStep, type StepMap, type Step } from 'prosemirror-transform';
import type { Transaction, EditorState } from 'prosemirror-state';

const SKIP = 'pm-projection-dirty-skip';

function changedRangesInFinalDoc(trs: readonly Transaction[]): Array<[number, number]> {
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
  appendTransaction(trs, _oldState: EditorState, newState: EditorState) {
    if (!trs.some((tr) => tr.docChanged)) return null;
    if (trs.some((tr) => tr.getMeta(SKIP))) return null;

    const ranges = changedRangesInFinalDoc(trs);
    if (!ranges.length) return null;

    const tr = newState.tr.setMeta(SKIP, true);
    let modified = false;
    newState.doc.forEach((block, offset) => {
      if (!('dirty' in block.attrs)) return; // frozen blocks never go dirty
      if (block.attrs.dirty) return;
      const from = offset;
      const to = offset + block.nodeSize;
      const overlaps = ranges.some(([cs, ce]) => cs < to && ce > from);
      if (overlaps) {
        tr.setNodeMarkup(from, undefined, { ...block.attrs, dirty: true });
        modified = true;
      }
    });
    return modified ? tr : null;
  }
});
