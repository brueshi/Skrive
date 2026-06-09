// The command layer for the Rich surface: the affordance/object-editing API that
// Stage 3's toolbar, selection bubble, slash menu, and palette all dispatch
// through. Every entry is a real ProseMirror `Command` — `(state, dispatch?,
// view?) => boolean` — so it round-trips through `serializeDoc` exactly like a
// typed edit and is testable headlessly (no DOM).
//
// Design note — block-type conversions reuse the stock prosemirror-commands /
// prosemirror-schema-list helpers (setBlockType, wrapIn, wrapInList, lift). Those
// reset a converted block's `gapBefore`/`src` and let the dirtyPlugin mark it, so
// the seam reconstructs to the canonical separator. This is deliberately the SAME
// behaviour as the typed-syntax path (the `# `, `> `, `- ` input rules in
// RichEditor.tsx, which also use these helpers): the affordance path and the
// typing path must be indistinguishable. The Stage 3 gate requires committed
// structure to serialize to *canonical* Markdown (satisfied here) and an
// *abandoned* insert to be byte-identical (guaranteed by the overlays never
// mutating the doc until commit) — not seam-preserving conversions, which would
// be a separate cross-cutting refinement.

import type { Command, EditorState } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import type { MarkType, Node as PMNode, ResolvedPos } from 'prosemirror-model';
import {
  setBlockType,
  wrapIn,
  lift,
  toggleMark,
  chainCommands,
  newlineInCode,
  splitBlock
} from 'prosemirror-commands';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import { schema } from './schema';

const nodes = schema.nodes;
const marks = schema.marks;

// ============================ Inline marks ============================

export const toggleStrong: Command = toggleMark(marks.strong);
export const toggleEm: Command = toggleMark(marks.em);
export const toggleCode: Command = toggleMark(marks.code);

// ============================ Block types ============================

/** Turn the current textblock(s) into a heading of the given level. */
export function setHeading(level: number): Command {
  return setBlockType(nodes.heading, { level });
}

/** Turn the current textblock(s) into a plain paragraph ("Normal text"). */
export const setParagraph: Command = setBlockType(nodes.paragraph);

/** Turn the current textblock into a fenced code block. */
export const setCodeBlock: Command = setBlockType(nodes.code_block);

// ============================ Hard breaks ============================

// The hard_break payload of Shift-Enter, valid only where a backslash hard
// break is valid Markdown. A heading is the exclusion that matters: ATX
// headings are single-line by definition, so `## a\` + newline re-parses as a
// heading plus a separate paragraph — the <br> the writer saw would not
// survive a round-trip. Returns false in a heading so the chain below can fall
// through to a split instead.
const hardBreakInProse: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  const heading = nodes.heading;
  if ($from.parent.type === heading || $to.parent.type === heading) return false;
  if (dispatch) {
    dispatch(
      state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView()
    );
  }
  return true;
};

/** Shift-Enter: a within-block line break. In a code block that is a literal
 *  newline (newlineInCode); in a heading it behaves like Enter and splits —
 *  Markdown has no in-heading line break, and a visible split is honest where
 *  a silent no-op would feel like a dead key; everywhere else it inserts a
 *  hard_break node, which serializes to a CommonMark backslash hard break and
 *  renders as <br>. */
export const insertHardBreak: Command = chainCommands(
  newlineInCode,
  hardBreakInProse,
  splitBlock
);

// ============================ Lists ============================

/** Walk from the cursor to the nearest ancestor list, if any. */
function nearestList($from: ResolvedPos): { node: PMNode; depth: number } | null {
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === nodes.bullet_list || node.type === nodes.ordered_list) {
      return { node, depth: d };
    }
  }
  return null;
}

// Toggle the current block into / out of a list of `listType`:
//   - not in a list        -> wrap in `listType`
//   - already in `listType` -> lift out (toggle off)
//   - in the OTHER list type -> convert that list's node type in place, so
//     bullet<->ordered is a one-click switch rather than a nested re-wrap.
function toggleList(listType: typeof nodes.bullet_list): Command {
  return (state, dispatch, view) => {
    const found = nearestList(state.selection.$from);
    if (!found) return wrapInList(listType)(state, dispatch, view);
    if (found.node.type === listType) {
      return liftListItem(nodes.list_item)(state, dispatch, view);
    }
    // Convert in place. Carry the seam/spread, drop the stale source so the
    // switched list serializes canonically in the new style.
    if (dispatch) {
      const pos = state.selection.$from.before(found.depth);
      const attrs =
        listType === nodes.ordered_list
          ? { gapBefore: found.node.attrs.gapBefore, src: null, dirty: true, start: 1, delimiter: '.', spread: found.node.attrs.spread }
          : { gapBefore: found.node.attrs.gapBefore, src: null, dirty: true, marker: '-', spread: found.node.attrs.spread };
      dispatch(state.tr.setNodeMarkup(pos, listType, attrs).scrollIntoView());
    }
    return true;
  };
}

export const toggleBulletList: Command = toggleList(nodes.bullet_list);
export const toggleOrderedList: Command = toggleList(nodes.ordered_list);

// ============================ Blockquote ============================

function inNodeOfType($from: ResolvedPos, type: typeof nodes.blockquote): boolean {
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === type) return true;
  }
  return false;
}

/** Wrap the current block in a blockquote, or lift it out if already quoted. */
export const toggleBlockquote: Command = (state, dispatch, view) => {
  if (inNodeOfType(state.selection.$from, nodes.blockquote)) {
    return lift(state, dispatch);
  }
  return wrapIn(nodes.blockquote)(state, dispatch, view);
};

// ============================ Inserts (divider / table) ============================

// A block-level insert lands one of two ways: when the cursor sits in an empty
// top-level paragraph (the common case after a slash trigger consumes the line),
// it REPLACES that paragraph; otherwise it inserts after the current top-level
// block. Returns the doc position the new node will occupy.
function emptyTopParagraphRange(
  state: EditorState
): { start: number; end: number } | null {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1) return null;
  const para = $from.parent;
  if (para.type.name !== 'paragraph' || para.content.size !== 0) return null;
  return { start: $from.before(1), end: $from.after(1) };
}

/** Insert a thematic break, leaving an empty paragraph below it for the cursor
 *  so the writer keeps going past the rule. Replaces the current line when it is
 *  an empty paragraph, else inserts after the current block. */
export const insertDivider: Command = (state, dispatch) => {
  if (dispatch) {
    const hr = nodes.horizontal_rule.create();
    const para = nodes.paragraph.create();
    const slot = emptyTopParagraphRange(state);
    let tr = state.tr;
    let afterRule: number;
    if (slot) {
      tr = tr.replaceRangeWith(slot.start, slot.end, hr);
      afterRule = slot.start + hr.nodeSize;
    } else {
      const pos = state.selection.$from.after(1);
      tr = tr.insert(pos, hr);
      afterRule = pos + hr.nodeSize;
    }
    tr.insert(afterRule, para);
    tr.setSelection(TextSelection.create(tr.doc, afterRule + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Insert a 2x2 GFM table (header row + one body row), cursor in the first
 *  header cell. Replaces the current line when it is an empty paragraph, else
 *  inserts after the current block. */
export const insertTable: Command = (state, dispatch) => {
  if (dispatch) {
    const headerRow = nodes.table_row.create(null, [
      nodes.table_header.create(),
      nodes.table_header.create()
    ]);
    const bodyRow = nodes.table_row.create(null, [
      nodes.table_cell.create(),
      nodes.table_cell.create()
    ]);
    const table = nodes.table.create(null, [headerRow, bodyRow]);
    const slot = emptyTopParagraphRange(state);
    let tr = state.tr;
    let tableStart: number;
    if (slot) {
      tr = tr.replaceRangeWith(slot.start, slot.end, table);
      tableStart = slot.start;
    } else {
      tableStart = state.selection.$from.after(1);
      tr = tr.insert(tableStart, table);
    }
    // +2: into the table, into the first row, into the first cell.
    tr.setSelection(TextSelection.create(tr.doc, tableStart + 2));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

// ============================ Links ============================

// The contiguous run of text carrying the link mark around `$pos`, plus the
// mark's href. Mirrors the standard ProseMirror "expand to mark boundary"
// walk: scan the parent's children left and right from the cursor while the
// link mark holds, summing node sizes to absolute positions.
function linkRangeAround(
  $pos: ResolvedPos,
  linkType: MarkType
): { from: number; to: number; href: string } | null {
  const parent = $pos.parent;
  const index = $pos.index();
  // At a boundary the cursor sits between two children; check the child to the
  // left as well so a click at the end of a link still finds it.
  const here = parent.maybeChild(index);
  const left = index > 0 ? parent.child(index - 1) : null;
  const mark =
    (here && linkType.isInSet(here.marks)) ||
    (left && linkType.isInSet(left.marks)) ||
    null;
  if (!mark) return null;

  let startIndex = here && linkType.isInSet(here.marks) ? index : index - 1;
  let endIndex = startIndex + 1;
  while (startIndex > 0 && linkType.isInSet(parent.child(startIndex - 1).marks)) {
    startIndex--;
  }
  while (
    endIndex < parent.childCount &&
    linkType.isInSet(parent.child(endIndex).marks)
  ) {
    endIndex++;
  }

  let from = $pos.start();
  for (let i = 0; i < startIndex; i++) from += parent.child(i).nodeSize;
  let to = from;
  for (let i = startIndex; i < endIndex; i++) to += parent.child(i).nodeSize;

  return { from, to, href: String(mark.attrs.href) };
}

/** Apply (or replace) a link over the selection. With a collapsed selection
 *  inside an existing link, retarget that whole link's range. */
export function setLink(href: string): Command {
  return (state, dispatch) => {
    const { selection } = state;
    let from = selection.from;
    let to = selection.to;
    if (selection.empty) {
      const range = linkRangeAround(selection.$from, marks.link);
      if (!range) return false; // nothing to link a bare cursor to
      from = range.from;
      to = range.to;
    }
    if (dispatch) {
      dispatch(
        state.tr
          .removeMark(from, to, marks.link)
          .addMark(from, to, marks.link.create({ href }))
          .scrollIntoView()
      );
    }
    return true;
  };
}

/** Strip the link mark from the selection, or from the link under a collapsed
 *  cursor. */
export const removeLink: Command = (state, dispatch) => {
  const { selection } = state;
  let from = selection.from;
  let to = selection.to;
  if (selection.empty) {
    const range = linkRangeAround(selection.$from, marks.link);
    if (!range) return false;
    from = range.from;
    to = range.to;
  }
  if (dispatch) dispatch(state.tr.removeMark(from, to, marks.link));
  return true;
};

// ============================ Selection summary ============================

// A minimal, serializable read of the current selection — what the toolbar and
// bubble need to render live state (which marks are on, what block type the
// cursor sits in, link target). Deliberately tiny: the selection-state plugin
// pushes this (rAF-coalesced, shallow-diffed) so live highlighting never routes
// the document through React. See selection-state.ts.
export type RichSelectionSummary = {
  empty: boolean;
  strong: boolean;
  em: boolean;
  code: boolean;
  link: boolean;
  linkHref: string | null;
  blockType: string;
  headingLevel: number | null;
  inBulletList: boolean;
  inOrderedList: boolean;
  inBlockquote: boolean;
  inTable: boolean;
};

export const EMPTY_SELECTION_SUMMARY: RichSelectionSummary = {
  empty: true,
  strong: false,
  em: false,
  code: false,
  link: false,
  linkHref: null,
  blockType: 'paragraph',
  headingLevel: null,
  inBulletList: false,
  inOrderedList: false,
  inBlockquote: false,
  inTable: false
};

export function readSelectionSummary(state: EditorState): RichSelectionSummary {
  const sel = state.selection;
  const { $from, empty } = sel;

  const markActive = (type: MarkType): boolean =>
    empty
      ? !!type.isInSet(state.storedMarks ?? $from.marks())
      : state.doc.rangeHasMark(sel.from, sel.to, type);

  let inBulletList = false;
  let inOrderedList = false;
  let inBlockquote = false;
  let inTable = false;
  for (let d = $from.depth; d > 0; d--) {
    switch ($from.node(d).type.name) {
      case 'bullet_list':
        inBulletList = true;
        break;
      case 'ordered_list':
        inOrderedList = true;
        break;
      case 'blockquote':
        inBlockquote = true;
        break;
      case 'table':
        inTable = true;
        break;
    }
  }

  const parent = $from.parent;
  const blockType = parent.type.name;
  const linkRange = empty
    ? linkRangeAround($from, marks.link)
    : state.doc.rangeHasMark(sel.from, sel.to, marks.link)
      ? linkRangeAround($from, marks.link)
      : null;

  return {
    empty,
    strong: markActive(marks.strong),
    em: markActive(marks.em),
    code: markActive(marks.code),
    link: linkRange != null,
    linkHref: linkRange?.href ?? null,
    blockType,
    headingLevel: blockType === 'heading' ? Number(parent.attrs.level) : null,
    inBulletList,
    inOrderedList,
    inBlockquote,
    inTable
  };
}

/** Shallow value-equality for two summaries — the selection-state store uses
 *  this to skip no-op pushes so the toolbar doesn't re-render on every cursor
 *  tick that lands on the same kind of content. */
export function summaryEqual(
  a: RichSelectionSummary,
  b: RichSelectionSummary
): boolean {
  return (
    a.empty === b.empty &&
    a.strong === b.strong &&
    a.em === b.em &&
    a.code === b.code &&
    a.link === b.link &&
    a.linkHref === b.linkHref &&
    a.blockType === b.blockType &&
    a.headingLevel === b.headingLevel &&
    a.inBulletList === b.inBulletList &&
    a.inOrderedList === b.inOrderedList &&
    a.inBlockquote === b.inBlockquote &&
    a.inTable === b.inTable
  );
}
