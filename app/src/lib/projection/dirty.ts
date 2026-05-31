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
// Frozen blocks have no `dirty` attribute and are skipped: they are always
// emitted verbatim and must never be canonicalized.

import { Plugin } from 'prosemirror-state';
import { Mapping, type StepMap } from 'prosemirror-transform';
import type { Transaction, EditorState } from 'prosemirror-state';

const SKIP = 'pm-projection-dirty-skip';

function changedRangesInFinalDoc(trs: readonly Transaction[]): Array<[number, number]> {
  const maps: StepMap[] = [];
  for (const tr of trs) maps.push(...tr.mapping.maps);
  const full = new Mapping(maps);

  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < maps.length; i++) {
    const map = maps[i];
    if (!map) continue;
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const rest = full.slice(i + 1);
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
    });
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
