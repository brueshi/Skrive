// Document-wide range operations (SKR-118, Stage 2). The transforms that splice
// across block boundaries, expressed over the position model: cross-block delete,
// boundary merge (Backspace at a block start / Delete at a block end), and
// type/paste-over-selection (delete then insert). Pure over the block tree.
//
// Scope today: inline-text leaves (paragraph / heading) at any depth, including
// inside lists and blockquotes — the prose cases. code_block / table / hr /
// frozen_block are BARRIERS: a merge across one is refused and a cross-block range
// that includes one is clamped (returns null), so a text edit can never corrupt a
// table or a code block. Those become first-class in a later sub-stage. (There is
// no image *block* — an image is an InlineNode embedded in a paragraph, not a
// barrier in its own right.)

import { generateBlockId, type BlockNode, type InlineNode } from '../blockmodel';
import { coalesceInline, deleteRangeInInline, inlineLength, insertTextInInline } from './inline-ops';
import { findBlockById, updateBlockById } from './tree';

export type RangeResult = { blocks: BlockNode[]; caret: { id: string; offset: number } };

type LeafKind = 'inline' | 'barrier';
type LeafEntry = { id: string; kind: LeafKind };

/** Editable leaves in document order, descending into lists and blockquotes.
 *  Inline-text leaves are mergeable; everything else (code/table/atoms) is a
 *  barrier that bounds merges and clamps ranges. */
export function documentLeaves(blocks: BlockNode[]): LeafEntry[] {
  const out: LeafEntry[] = [];
  const walk = (nodes: BlockNode[]): void => {
    for (const b of nodes) {
      if (b.type === 'paragraph' || b.type === 'heading') out.push({ id: b.id, kind: 'inline' });
      else if (b.type === 'blockquote' || b.type === 'footnote_definition') walk(b.children);
      else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        for (const item of b.items) walk(item.children);
      } else out.push({ id: b.id, kind: 'barrier' }); // code_block / table / hr / frozen_block
    }
  };
  walk(blocks);
  return out;
}

function inlineLeaf(blocks: BlockNode[], id: string): Extract<BlockNode, { type: 'paragraph' | 'heading' }> | null {
  const b = findBlockById(blocks, id);
  return b && (b.type === 'paragraph' || b.type === 'heading') ? b : null;
}

// Remove the blocks whose ids are in `ids` from anywhere in the tree, pruning a
// list item / list / blockquote that empties as a result. Ancestors of a removal
// are marked dirty so they re-serialize around the change.
export function removeBlocks(blocks: BlockNode[], ids: Set<string>): BlockNode[] {
  const walk = (nodes: BlockNode[]): BlockNode[] => {
    const out: BlockNode[] = [];
    for (const b of nodes) {
      if (ids.has(b.id)) continue;
      if (b.type === 'blockquote' || b.type === 'footnote_definition') {
        const children = walk(b.children);
        if (children.length === 0) continue; // emptied container: prune
        out.push(children === b.children ? b : { ...b, children, dirty: true });
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        let changed = false;
        const items = b.items
          .map((item) => {
            const children = walk(item.children);
            if (children !== item.children) changed = true;
            return { ...item, children };
          })
          .filter((item) => item.children.length > 0); // emptied item: prune
        if (items.length === 0) continue; // emptied list: prune
        out.push(changed || items.length !== b.items.length ? { ...b, items, dirty: true } : b);
      } else {
        out.push(b);
      }
    }
    return out;
  };
  return walk(blocks);
}

const headOf = (inline: InlineNode[], offset: number): InlineNode[] =>
  deleteRangeInInline(inline, offset, inlineLength(inline));
const tailOf = (inline: InlineNode[], offset: number): InlineNode[] => deleteRangeInInline(inline, 0, offset);

/** First inline-leaf index in [from, to], or -1 when the span holds only barriers. */
function firstInlineIndex(leaves: LeafEntry[], from: number, to: number): number {
  for (let i = from; i <= to; i++) if (leaves[i]!.kind === 'inline') return i;
  return -1;
}
/** Last inline-leaf index in [from, to], or -1 when the span holds only barriers. */
function lastInlineIndex(leaves: LeafEntry[], from: number, to: number): number {
  for (let i = to; i >= from; i--) if (leaves[i]!.kind === 'inline') return i;
  return -1;
}

/**
 * Delete the content between two positions in document order. The start leaf
 * keeps its id + type and receives `head(start) + tail(end)`; every block strictly
 * between is removed — including a fully-covered barrier (a divider / code block /
 * table caught entirely inside the selection) — and emptied containers pruned.
 *
 * A code block / table can never be partial-cut, so an ENDPOINT that lands inside
 * one is snapped inward to the prose it bounds rather than eating the gesture
 * (SKR-166): an end inside a barrier retreats to the end of the last inline leaf
 * before it, a start inside a barrier advances to the start of the first inline
 * leaf after it. The barrier block itself survives; the prose up to its edge is
 * deleted — Google Docs behaviour. Null only when the range holds no prose to
 * delete at all (e.g. an endpoint pair with only barriers between them). Caret
 * lands at the join (the snapped start).
 */
export function deleteAcross(
  blocks: BlockNode[],
  startId: string,
  startOffset: number,
  endId: string,
  endOffset: number
): RangeResult | null {
  if (startId === endId) {
    const leaf = inlineLeaf(blocks, startId);
    if (!leaf) return null;
    const inline = deleteRangeInInline(leaf.inline, startOffset, endOffset);
    return {
      blocks: updateBlockById(blocks, startId, (b) => ({ ...b, inline, dirty: true }) as BlockNode),
      caret: { id: startId, offset: startOffset }
    };
  }

  const leaves = documentLeaves(blocks);
  const si0 = leaves.findIndex((l) => l.id === startId);
  const ei0 = leaves.findIndex((l) => l.id === endId);
  if (si0 < 0 || ei0 < 0 || si0 >= ei0) return null;

  // Shrink barrier endpoints inward so the barrier survives while its surrounding
  // prose is deleted; barriers fully BETWEEN the (snapped) ends are still removed.
  let si = si0;
  let ei = ei0;
  let sOff = startOffset;
  let eOff = endOffset;
  if (leaves[si]!.kind === 'barrier') {
    const ni = firstInlineIndex(leaves, si + 1, ei);
    if (ni < 0) return null; // nothing but barriers ahead of the start
    si = ni;
    sOff = 0;
  }
  if (leaves[ei]!.kind === 'barrier') {
    const pi = lastInlineIndex(leaves, si, ei - 1);
    if (pi < 0) return null; // nothing but barriers behind the end
    const pl = inlineLeaf(blocks, leaves[pi]!.id);
    if (!pl) return null;
    ei = pi;
    eOff = inlineLength(pl.inline);
  }

  const startLeaf = inlineLeaf(blocks, leaves[si]!.id);
  const endLeaf = inlineLeaf(blocks, leaves[ei]!.id);
  if (!startLeaf || !endLeaf) return null;

  // Both endpoints snapped onto the same inline leaf (a barrier-bounded prose run):
  // a within-leaf delete.
  if (si === ei) {
    const inline = deleteRangeInInline(startLeaf.inline, sOff, eOff);
    return {
      blocks: updateBlockById(blocks, startLeaf.id, (b) => ({ ...b, inline, dirty: true }) as BlockNode),
      caret: { id: startLeaf.id, offset: sOff }
    };
  }

  // The join can butt two same-mark runs against each other; merge the seam.
  const merged = coalesceInline([...headOf(startLeaf.inline, sOff), ...tailOf(endLeaf.inline, eOff)]);
  const removeIds = new Set<string>();
  for (let i = si + 1; i <= ei; i++) removeIds.add(leaves[i]!.id);

  let next = updateBlockById(blocks, startLeaf.id, (b) => ({ ...b, inline: merged, dirty: true }) as BlockNode);
  next = removeBlocks(next, removeIds);
  return { blocks: next, caret: { id: startLeaf.id, offset: sOff } };
}

/**
 * Delete a whole barrier block (table / code block / divider / image) by id —
 * the "select it and hit Delete" path, since a barrier can't be partial-cut by a
 * text range. The caret lands at the end of the previous inline leaf, else the
 * start of the next, else a fresh empty paragraph when nothing inline remains
 * (the barrier was the only content). Null when `id` is not a known leaf.
 */
export function deleteBlock(blocks: BlockNode[], id: string): RangeResult | null {
  const leaves = documentLeaves(blocks);
  const ti = leaves.findIndex((l) => l.id === id);
  if (ti < 0) return null;

  // Prefer the previous inline leaf (caret at its end), else the next (its start).
  let caret: { id: string; offset: number } | null = null;
  for (let i = ti - 1; i >= 0 && !caret; i--) {
    if (leaves[i]!.kind !== 'inline') continue;
    const leaf = inlineLeaf(blocks, leaves[i]!.id);
    if (leaf) caret = { id: leaf.id, offset: inlineLength(leaf.inline) };
  }
  for (let i = ti + 1; i < leaves.length && !caret; i++) {
    if (leaves[i]!.kind === 'inline') caret = { id: leaves[i]!.id, offset: 0 };
  }

  const wasFirst = blocks[0]?.id === id;
  let next = removeBlocks(blocks, new Set([id]));
  // Removing the leading block would leave the new first block's seam (e.g. the
  // blank line that separated it from the deleted table) as leading blank lines.
  // Clear it so the document doesn't start with stray blanks.
  if (wasFirst && next.length > 0 && next[0]!.gapBefore) {
    next = [{ ...next[0]!, gapBefore: '' } as BlockNode, ...next.slice(1)];
  }
  if (!caret) {
    // No inline leaf left to hold the caret — seed an empty paragraph.
    const para: BlockNode = {
      type: 'paragraph',
      id: generateBlockId(),
      durable: false,
      src: null,
      gapBefore: null,
      dirty: true,
      inline: []
    };
    next = [...next, para];
    caret = { id: para.id, offset: 0 };
  }
  return { blocks: next, caret };
}

/**
 * Remove a footnote wholesale: its definition block AND every reference atom
 * carrying its label, anywhere in the document (body prose, containers, table
 * cells) — the explicit "delete this footnote" action on the definition's
 * chrome, the footer-side counterpart of the reference-side prune. Caret lands
 * where the FIRST reference was (its former offset), since that is where the
 * writer's prose just changed; with no references (an orphan definition) it
 * lands at the end of the last body leaf, or a seeded paragraph when nothing
 * else remains. Null when no definition carries the label.
 */
export function removeFootnote(blocks: BlockNode[], label: string): RangeResult | null {
  let defId: string | null = null;
  for (const b of blocks) {
    if (b.type === 'footnote_definition' && b.label === label) {
      defId = b.id;
      break;
    }
  }
  if (!defId) return null;

  let caret: { id: string; offset: number } | null = null;

  const stripInline = (nodes: InlineNode[], note?: (offset: number) => void): InlineNode[] => {
    let changed = false;
    let acc = 0;
    const out: InlineNode[] = [];
    for (const n of nodes) {
      if (n.kind === 'footnote_ref' && n.label === label) {
        note?.(acc);
        changed = true;
        continue;
      }
      acc += inlineLength([n]);
      out.push(n);
    }
    return changed ? coalesceInline(out) : nodes;
  };

  const walk = (nodes: BlockNode[]): BlockNode[] => {
    let changed = false;
    const out = nodes.map((b): BlockNode => {
      if (b.type === 'paragraph' || b.type === 'heading') {
        const inline = stripInline(b.inline, (offset) => {
          caret ??= { id: b.id, offset };
        });
        if (inline === b.inline) return b;
        changed = true;
        return { ...b, inline, dirty: true };
      }
      if (b.type === 'blockquote' || b.type === 'footnote_definition') {
        const children = walk(b.children);
        if (children === b.children) return b;
        changed = true;
        return { ...b, children, dirty: true };
      }
      if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        let itemsChanged = false;
        const items = b.items.map((item) => {
          const children = walk(item.children);
          if (children === item.children) return item;
          itemsChanged = true;
          return { ...item, children };
        });
        if (!itemsChanged) return b;
        changed = true;
        return { ...b, items, dirty: true };
      }
      if (b.type === 'table') {
        let rowsChanged = false;
        // Cells are never the caret target: a table is a range barrier, so the
        // caret stays with the first PROSE reference (or the body fallback).
        const rows = b.rows.map((row) => {
          let rowChanged = false;
          const cells = row.map((cell) => {
            const stripped = stripInline(cell);
            if (stripped !== cell) rowChanged = true;
            return stripped;
          });
          return rowChanged ? ((rowsChanged = true), cells) : row;
        });
        if (!rowsChanged) return b;
        changed = true;
        return { ...b, rows, dirty: true };
      }
      return b;
    });
    return changed ? out : nodes;
  };

  const next = removeBlocks(walk(blocks), new Set([defId]));
  if (caret) return { blocks: next, caret };

  // Orphan definition (no references anywhere): prefer the end of the last BODY
  // leaf — the footer sits below the body, so that is the nearest prose — then
  // any inline leaf, then a seeded paragraph when the definition was all there was.
  const leaves = documentLeaves(next);
  let fallback: { id: string; offset: number } | null = null;
  for (let i = leaves.length - 1; i >= 0; i--) {
    const entry = leaves[i]!;
    if (entry.kind !== 'inline') continue;
    const leaf = inlineLeaf(next, entry.id);
    if (!leaf) continue;
    fallback ??= { id: leaf.id, offset: inlineLength(leaf.inline) };
    if (footnoteDefAncestorId(next, entry.id) === null) {
      return { blocks: next, caret: { id: leaf.id, offset: inlineLength(leaf.inline) } };
    }
  }
  if (fallback) return { blocks: next, caret: fallback };
  const para: BlockNode = {
    type: 'paragraph',
    id: generateBlockId(),
    durable: false,
    src: null,
    gapBefore: null,
    dirty: true,
    inline: []
  };
  return { blocks: [...next, para], caret: { id: para.id, offset: 0 } };
}

/** The id of the footnote definition containing `leafId`, or null when the leaf
 *  lives in the document body. Definitions are top-level containers (GFM
 *  footnote definitions are flow content, never nested), so one pass over the
 *  top-level defs suffices. Used to refuse a merge across the body/footer seam:
 *  the footer renders at the document end regardless of the definition's model
 *  position, so a merge across that boundary would visually teleport text. */
function footnoteDefAncestorId(blocks: BlockNode[], leafId: string): string | null {
  for (const b of blocks) {
    if (b.type === 'footnote_definition' && findBlockById(b.children, leafId)) return b.id;
  }
  return null;
}

/** Backspace at the start of an inline leaf: merge it into the previous inline
 *  leaf in document order (across a list / quote boundary). Null when it is the
 *  first leaf, the previous leaf is a barrier (don't merge into a table/code),
 *  or the merge would cross a footnote-definition boundary (a definition's body
 *  never bleeds into the document body, and vice versa). */
export function mergeBackward(blocks: BlockNode[], leafId: string): RangeResult | null {
  const leaves = documentLeaves(blocks);
  const i = leaves.findIndex((l) => l.id === leafId);
  if (i <= 0) return null;
  const prev = leaves[i - 1]!;
  if (prev.kind !== 'inline') return null;
  if (footnoteDefAncestorId(blocks, leafId) !== footnoteDefAncestorId(blocks, prev.id)) return null;
  const prevLeaf = inlineLeaf(blocks, prev.id);
  if (!prevLeaf) return null;
  return deleteAcross(blocks, prev.id, inlineLength(prevLeaf.inline), leafId, 0);
}

/** Delete at the end of an inline leaf: pull the next inline leaf up into it.
 *  Null when it is the last leaf, the next leaf is a barrier, or the merge would
 *  cross a footnote-definition boundary (mirror of mergeBackward). */
export function mergeForward(blocks: BlockNode[], leafId: string): RangeResult | null {
  const leaves = documentLeaves(blocks);
  const i = leaves.findIndex((l) => l.id === leafId);
  if (i < 0 || i >= leaves.length - 1) return null;
  const next = leaves[i + 1]!;
  if (next.kind !== 'inline') return null;
  if (footnoteDefAncestorId(blocks, leafId) !== footnoteDefAncestorId(blocks, next.id)) return null;
  const cur = inlineLeaf(blocks, leafId);
  if (!cur) return null;
  return deleteAcross(blocks, leafId, inlineLength(cur.inline), next.id, 0);
}

/**
 * The block adjacent to `leafId` in `direction`, when that neighbor is the
 * reason mergeBackward/mergeForward returned null (i.e. it's a barrier —
 * code_block / table / hr / frozen_block — rather than there being no leaf
 * at all in that direction). Callers use this to decide what a merge-null
 * Backspace/Delete should do instead of silently no-opping (SKR-167, extended to
 * frozen blocks by SKR-216): delete a content-free atom like an hr outright, or
 * select a content-bearing barrier like a code block / table / frozen block as a
 * unit. Null when there is no leaf in that direction, or the neighbor is inline
 * (mergeBackward/mergeForward would have succeeded instead of returning null).
 */
export function barrierNeighbor(blocks: BlockNode[], leafId: string, direction: 'backward' | 'forward'): BlockNode | null {
  const leaves = documentLeaves(blocks);
  const i = leaves.findIndex((l) => l.id === leafId);
  if (i < 0) return null;
  const j = direction === 'backward' ? i - 1 : i + 1;
  if (j < 0 || j >= leaves.length) return null;
  const neighbor = leaves[j]!;
  if (neighbor.kind !== 'barrier') return null;
  return findBlockById(blocks, neighbor.id);
}

/** Replace a cross-block range with typed/pasted text: delete the range, then
 *  insert `text` at the join. The insertion follows the deleted range's caret, so
 *  a barrier-snapped delete (see deleteAcross) types into the surviving prose leaf,
 *  not the original — possibly-barrier — endpoint. Null when nothing deletes. */
export function replaceAcross(
  blocks: BlockNode[],
  startId: string,
  startOffset: number,
  endId: string,
  endOffset: number,
  text: string
): RangeResult | null {
  const deleted = deleteAcross(blocks, startId, startOffset, endId, endOffset);
  if (!deleted) return null;
  if (text.length === 0) return deleted;
  const { id, offset } = deleted.caret;
  const leaf = inlineLeaf(deleted.blocks, id);
  if (!leaf) return deleted; // caret not on an inline leaf: leave the delete as-is
  const inline = insertTextInInline(leaf.inline, offset, text);
  return {
    blocks: updateBlockById(deleted.blocks, id, (b) => ({ ...b, inline, dirty: true }) as BlockNode),
    caret: { id, offset: offset + text.length }
  };
}

/**
 * Clear the text of every cell in the rectangle [minRow..maxRow] x [minCol..maxCol]
 * of a table, leaving the table and its shape intact. This is the in-table
 * cross-cell delete (SKR-166 / F55): dragging a selection across cells and hitting
 * Backspace empties the covered cells — Google Docs behaviour — rather than
 * deleting the whole table (which a barrier range would otherwise do). Null when
 * `tableId` is not a table.
 */
export function clearTableCells(
  blocks: BlockNode[],
  tableId: string,
  minRow: number,
  minCol: number,
  maxRow: number,
  maxCol: number
): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    const rows = b.rows.map((row, r) =>
      r < minRow || r > maxRow ? row : row.map((cell, c) => (c < minCol || c > maxCol ? cell : []))
    );
    return { ...b, rows, dirty: true } as BlockNode;
  });
}

/**
 * Append one empty row (same column count as row 0) to the end of a table.
 * The minimal Docs/Word muscle-memory slice for table structure editing
 * (SKR-225 / F-tables): Tab in the last cell used to fall through to
 * exitBarrier and leave the table entirely — this gives it somewhere to grow
 * instead. Column ops, row deletion, and a creation-size choice are explicitly
 * deferred (v1.10). Null when `tableId` is not a table.
 */
export function appendTableRow(blocks: BlockNode[], tableId: string): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  const cols = table.rows[0]?.length ?? 0;
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    const row: InlineNode[][] = Array.from({ length: cols }, () => []);
    return { ...b, rows: [...b.rows, row], dirty: true } as BlockNode;
  });
}

// Re-export so callers that need a fresh id for any future split path have it.
export { generateBlockId };
