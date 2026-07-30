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

import { generateBlockId, type BlockNode, type InlineNode, type TableAlign } from '../blockmodel';
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

  // A footnote definition renders in the document-end footer regardless of its
  // model position, so its leaves are VISUALLY outside any body range (and vice
  // versa). An endpoint pair straddling a definition boundary retreats the end
  // into the start's region — the same clamp shape as a barrier endpoint — and
  // definitions lying model-order-between two body endpoints survive untouched
  // (removing them because an imported `.md` authored its definitions
  // mid-document would delete footer content the writer never selected).
  const regionOf = (id: string): string | null => footnoteDefAncestorId(blocks, id);
  const region = regionOf(leaves[si]!.id);
  if (regionOf(leaves[ei]!.id) !== region) {
    let pi = -1;
    for (let i = ei - 1; i >= si; i--) {
      if (leaves[i]!.kind === 'inline' && regionOf(leaves[i]!.id) === region) {
        pi = i;
        break;
      }
    }
    if (pi < 0) return null; // nothing of the start's region inside the range
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
  for (let i = si + 1; i <= ei; i++) {
    // A leaf in a DIFFERENT footnote region sits in the footer, not in this
    // range's visual span — leave its definition intact (see the region clamp).
    if (regionOf(leaves[i]!.id) !== region) continue;
    removeIds.add(leaves[i]!.id);
  }

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

/** The first reference carrying `label` that can host a caret (paragraph /
 *  heading prose, at any depth outside a table), as its leaf id + the atom's
 *  flat offset. Document order; null when no such reference exists. */
function firstFootnoteRefPos(blocks: BlockNode[], label: string): { id: string; offset: number } | null {
  const scanInline = (nodes: InlineNode[], id: string): { id: string; offset: number } | null => {
    let acc = 0;
    for (const n of nodes) {
      if (n.kind === 'footnote_ref' && n.label === label) return { id, offset: acc };
      acc += inlineLength([n]);
    }
    return null;
  };
  const walk = (nodes: BlockNode[]): { id: string; offset: number } | null => {
    for (const b of nodes) {
      if (b.type === 'paragraph' || b.type === 'heading') {
        const hit = scanInline(b.inline, b.id);
        if (hit) return hit;
      } else if (b.type === 'blockquote' || b.type === 'footnote_definition') {
        const hit = walk(b.children);
        if (hit) return hit;
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        for (const item of b.items) {
          const hit = walk(item.children);
          if (hit) return hit;
        }
      }
      // Table cells are skipped: a cell reference exists but cannot take the
      // returned caret (cells are coordinate-addressed, not leaf blocks).
    }
    return null;
  };
  return walk(blocks);
}

/**
 * Enter on an EMPTY leaf inside a footnote definition: leave the note and return
 * to the prose — caret lands just after the definition's first reference, the
 * mirror of insertFootnote's caret-into-the-definition move. The empty leaf is
 * removed unless it is the definition's whole body (a definition always keeps
 * one block). Null when the leaf is not an empty inline-text child of a
 * definition, or the definition has no reference to return to (an orphan) —
 * the caller then falls through to its other Enter semantics.
 */
export function exitFootnoteDefinition(blocks: BlockNode[], leafId: string): RangeResult | null {
  const defId = footnoteDefAncestorId(blocks, leafId);
  if (!defId) return null;
  const leaf = inlineLeaf(blocks, leafId);
  if (!leaf || inlineLength(leaf.inline) > 0) return null;
  const def = blocks.find((b) => b.id === defId);
  if (!def || def.type !== 'footnote_definition') return null;
  const ref = firstFootnoteRefPos(blocks, def.label);
  if (!ref || ref.id === leafId) return null;
  // removeBlocks prunes a container that empties; if that takes the definition
  // itself, the empty leaf was its whole body — keep it and just leave.
  let next = removeBlocks(blocks, new Set([leafId]));
  if (!next.some((b) => b.id === defId)) next = blocks;
  return { blocks: next, caret: { id: ref.id, offset: ref.offset + 1 } };
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

/**
 * Insert one empty row into a table at `index` (clamped to `[0, rowCount]`). The
 * new row matches the header's column count. Callers pass the caret row for an
 * "above" insert and caret-row + 1 for "below". Null when `tableId` is not a table.
 */
export function insertTableRow(blocks: BlockNode[], tableId: string, index: number): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  const cols = table.rows[0]?.length ?? 0;
  const at = Math.max(0, Math.min(index, table.rows.length));
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    const row: InlineNode[][] = Array.from({ length: cols }, () => []);
    const rows = [...b.rows.slice(0, at), row, ...b.rows.slice(at)];
    return { ...b, rows, dirty: true } as BlockNode;
  });
}

/**
 * Insert one empty column into a table at `index` (clamped to `[0, colCount]`). An
 * empty cell is spliced into every row and a `null` (no-alignment) entry into
 * `align`, so the delimiter row stays the same width as the header. When the table
 * carries explicit `widths`, the new column takes the average of the existing
 * weights (so it reads as a typical column) and is spliced in lockstep — widths
 * are relative and normalized at render, so no renormalization is needed. A ragged
 * row shorter than `index` gains its cell at its own end (splice clamps) — the row
 * is left ragged, never padded. Null when `tableId` is not a table.
 */
export function insertTableColumn(blocks: BlockNode[], tableId: string, index: number): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  const cols = table.rows[0]?.length ?? 0;
  const at = Math.max(0, Math.min(index, cols));
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    const rows = b.rows.map((row) => {
      const next = [...row];
      next.splice(at, 0, []);
      return next;
    });
    const align = [...b.align];
    align.splice(at, 0, null);
    const widths = spliceColumnWidth(b.widths, at);
    return { ...b, align, ...(widths ? { widths } : {}), rows, dirty: true } as BlockNode;
  });
}

/**
 * Remove row `index` from a table. Removing the header row (index 0) simply lets
 * the next row become the header — `align` is column-indexed, so it survives and
 * the table stays valid GFM. Returns null when `tableId` is not a table OR the
 * removal would empty the table (it holds only that one row); the surface routes a
 * null-from-a-known-table to whole-table deletion.
 */
export function removeTableRow(blocks: BlockNode[], tableId: string, index: number): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  if (table.rows.length <= 1 || index < 0 || index >= table.rows.length) return null;
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    const rows = [...b.rows.slice(0, index), ...b.rows.slice(index + 1)];
    return { ...b, rows, dirty: true } as BlockNode;
  });
}

/**
 * Remove column `index` from a table: drop that cell from every row, its `align`
 * entry, and (when present) its `widths` weight — keeping all three the header's
 * width. The surviving weights are left as-is; render renormalizes, so the other
 * columns keep their relative proportions. A ragged row with no cell at `index` is
 * untouched (splice on a short row is a no-op) — raggedness is preserved, not
 * repaired. Returns null when `tableId` is not a table OR the table has a single
 * column (removal would leave zero columns); the surface routes that null to
 * whole-table deletion.
 */
export function removeTableColumn(blocks: BlockNode[], tableId: string, index: number): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  const cols = table.rows[0]?.length ?? 0;
  if (cols <= 1 || index < 0 || index >= cols) return null;
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    const rows = b.rows.map((row) => {
      if (index >= row.length) return row;
      const next = [...row];
      next.splice(index, 1);
      return next;
    });
    const align = [...b.align];
    align.splice(index, 1);
    const widths = dropColumnWidth(b.widths, index);
    return { ...b, align, ...(widths ? { widths } : {}), rows, dirty: true } as BlockNode;
  });
}

/**
 * Set column `col`'s alignment. `align` is column-indexed, so the delimiter row
 * re-serializes from it (`:---`, `---:`, `:---:`, or `---` for null) and stays the
 * header's width. Returns null when `tableId` is not a table, `col` is out of the
 * header's range, or the alignment is unchanged (a no-op earns no undo step). The
 * `align` array is defensively padded to the header width first, upholding the
 * length invariant even against a malformed input.
 */
export function setColumnAlignment(
  blocks: BlockNode[],
  tableId: string,
  col: number,
  align: TableAlign
): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  const cols = table.rows[0]?.length ?? 0;
  if (col < 0 || col >= cols) return null;
  if ((table.align[col] ?? null) === align) return null;
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    const next = [...b.align];
    while (next.length < cols) next.push(null);
    next[col] = align;
    return { ...b, align: next, dirty: true } as BlockNode;
  });
}

/**
 * Replace a table's per-column width weights — the drag-resize commit. `widths`
 * must match the header's column count and be all-positive finite numbers; a
 * length mismatch, a bad entry, or a set equal to the current one returns null
 * (the last so re-committing identical widths earns no undo step). Weights are
 * relative (the renderer normalizes them), so the caller passes whatever
 * proportions the drag produced. `.folio`-only: `.md` never serializes widths, so
 * byte-stable GFM is untouched. Null also when `tableId` is not a table.
 */
export function setTableColumnWidths(
  blocks: BlockNode[],
  tableId: string,
  widths: number[]
): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  const cols = table.rows[0]?.length ?? 0;
  if (cols === 0 || widths.length !== cols) return null;
  if (!widths.every((w) => Number.isFinite(w) && w > 0)) return null;
  if (widthsEqual(table.widths, widths)) return null;
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    return { ...b, widths: [...widths], dirty: true } as BlockNode;
  });
}

// Splice a weight for a newly inserted column, in lockstep with `align`/`rows`.
// No-op (undefined) on a width-free table — it stays under auto layout. The new
// column takes the average of the existing weights so it reads as a typical
// column; render normalizes, so the sum need not stay fixed.
function spliceColumnWidth(widths: number[] | undefined, at: number): number[] | undefined {
  if (!widths) return undefined;
  const next = [...widths];
  const avg = next.length ? next.reduce((sum, w) => sum + w, 0) / next.length : 1;
  next.splice(at, 0, avg);
  return next;
}

// Drop the weight for a removed column. No-op (undefined) on a width-free table.
function dropColumnWidth(widths: number[] | undefined, index: number): number[] | undefined {
  if (!widths) return undefined;
  const next = [...widths];
  next.splice(index, 1);
  return next;
}

// Exact element-wise equality (weights round-trip verbatim, so no epsilon), with
// an absent array never equal to a present one.
function widthsEqual(a: number[] | undefined, b: number[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Move the element at `from` to sit at `insertAt` (post-removal index), returning a
// fresh array. Spreads the removed slice back in, so it never trips the
// possibly-undefined index type.
function spliceMove<T>(arr: T[], from: number, insertAt: number): T[] {
  const next = arr.slice();
  const removed = next.splice(from, 1);
  next.splice(insertAt, 0, ...removed);
  return next;
}

/**
 * Move a body row to a new position (drag-to-reorder, SKR-271). `to` is an
 * insertion BOUNDARY in `[0, rowCount]` — the drop line between rows — not a final
 * index, so it maps straight from where the drop indicator sits. The GFM header is
 * PINNED: row 0 never moves and nothing drops above it, so `from` and `to` must both
 * be >= 1 — a data row can never silently become the header. Returns null when
 * `tableId` is not a table, an index is out of range, or the drop would not change
 * the order (`to === from` or `to === from + 1`, the boundaries flanking the row),
 * so a no-op drag earns no undo step. The moved row lands at index
 * `to > from ? to - 1 : to`.
 */
export function moveTableRow(blocks: BlockNode[], tableId: string, from: number, to: number): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  const n = table.rows.length;
  if (from < 1 || from >= n) return null; // header pinned; row must be a body row
  if (to < 1 || to > n) return null; // never drop above the header
  if (to === from || to === from + 1) return null; // flanking boundaries: no move
  const insertAt = to > from ? to - 1 : to;
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    return { ...b, rows: spliceMove(b.rows, from, insertAt), dirty: true } as BlockNode;
  });
}

/**
 * Move a column to a new position (drag-to-reorder, SKR-271). `to` is an insertion
 * BOUNDARY in `[0, colCount]`. Every row's cell, plus the `align` entry and (when
 * present) the `widths` weight, move in lockstep — so the delimiter row and the
 * fixed-layout colgroup stay column-aligned. Ragged rows are preserved: a row with
 * no cell at `from` is untouched, and a shorter row reinserts its cell clamped to
 * its own end rather than padding. Returns null when `tableId` is not a table, an
 * index is out of range, or the boundary flanks the column (no reorder). The moved
 * column lands at index `to > from ? to - 1 : to`.
 */
export function moveTableColumn(blocks: BlockNode[], tableId: string, from: number, to: number): BlockNode[] | null {
  const table = findBlockById(blocks, tableId);
  if (!table || table.type !== 'table') return null;
  const cols = table.rows[0]?.length ?? 0;
  if (from < 0 || from >= cols) return null;
  if (to < 0 || to > cols) return null;
  if (to === from || to === from + 1) return null;
  const insertAt = to > from ? to - 1 : to;
  return updateBlockById(blocks, tableId, (b) => {
    if (b.type !== 'table') return b;
    const rows = b.rows.map((row) => {
      if (from >= row.length) return row; // ragged: no cell in this column to move
      const next = [...row];
      const removed = next.splice(from, 1);
      next.splice(Math.min(insertAt, next.length), 0, ...removed);
      return next;
    });
    const align = spliceMove(b.align, from, insertAt);
    const widths = b.widths ? spliceMove(b.widths, from, insertAt) : undefined;
    return { ...b, align, ...(widths ? { widths } : {}), rows, dirty: true } as BlockNode;
  });
}

/**
 * Clear the captured seam on the given ids, leaving every other field — including
 * `dirty` and `src` — untouched.
 *
 * A `gapBefore` is the VERBATIM bytes at the seam before a block, and the
 * serializer honours it wherever the block ends up (`gapForSeam`). That is right
 * while a block stays put and wrong the moment it moves: a block carrying `"\n\n"`
 * dropped at the top of the document would open the file with a blank line, and the
 * old first block (seam `null`, which renders as `''` only at index 0) would glue
 * itself to whatever now precedes it. Nulling the disturbed seams hands them back
 * to the reconstruction rule — nothing before the first block, a blank line
 * otherwise — which is the canonical spacing a reorder should produce.
 *
 * `dirty` deliberately stays as it was: the block's BODY has not changed, so a
 * clean block goes on emitting its `src` byte-pristine. Only the seam moved.
 */
function clearSeams(blocks: BlockNode[], ids: Set<string>): BlockNode[] {
  return blocks.map((b) => (ids.has(b.id) && b.gapBefore != null ? { ...b, gapBefore: null } : b));
}

/**
 * Move a top-level block to a new position (grip drag-to-reorder). `to` is an
 * insertion BOUNDARY in `[0, blocks.length]` — the drop line between blocks, not a
 * final index — so it maps straight from where the drop indicator sits, exactly as
 * `moveTableRow`'s does. The moved block lands at `to > from ? to - 1 : to`.
 *
 * Top-level only, by design: the grip is a top-level affordance, so `id` must name
 * a block in `blocks` itself. A nested block (a list item's paragraph, a quote's
 * child) returns null rather than being lifted out of its container — that would be
 * an outdent wearing a reorder's clothes, and `list-ops` already owns outdenting.
 *
 * Returns null when `id` is not a top-level block, `to` is out of range, or the
 * boundary flanks the block (`to === from` or `to === from + 1`), so a no-op drag
 * earns no undo step.
 */
export function moveBlock(blocks: BlockNode[], id: string, to: number): BlockNode[] | null {
  const from = blocks.findIndex((b) => b.id === id);
  if (from < 0) return null; // not top-level (or gone)
  if (to < 0 || to > blocks.length) return null;
  if (to === from || to === from + 1) return null; // flanking boundaries: no move
  const insertAt = to > from ? to - 1 : to;
  // The three seams a move disturbs, captured BEFORE the splice while the old
  // neighbourhood is still readable: the block's own, the one that closes the gap
  // it left behind, and the one it now sits in front of. Any of these may be
  // absent (moving from or to the end of the document).
  const disturbed = new Set<string>([id]);
  const vacated = blocks[from + 1];
  if (vacated) disturbed.add(vacated.id);
  const displaced = blocks[to];
  if (displaced) disturbed.add(displaced.id);
  return clearSeams(spliceMove(blocks, from, insertAt), disturbed);
}

/**
 * Insert a fresh empty paragraph immediately before a top-level block (the `+`
 * beside the grip), with the caret landing in it. Top-level only, for the same
 * reason `moveBlock` is: this is the grip's companion affordance.
 *
 * The displaced block's captured seam is cleared — it described the gap to a
 * predecessor that is no longer there.
 *
 * Note the paragraph is invisible in serialized Markdown until it holds text: an
 * empty paragraph has no Markdown form and the serializer drops it whole, seam and
 * all. It is real in the model and in `.folio` (where a blank line the writer typed
 * genuinely belongs), and it materializes in `.md` the moment it is typed into.
 */
export function insertBlockBefore(blocks: BlockNode[], id: string): RangeResult | null {
  const at = blocks.findIndex((b) => b.id === id);
  if (at < 0) return null; // not top-level (or gone)
  const para: BlockNode = {
    type: 'paragraph',
    id: generateBlockId(),
    durable: false,
    src: null,
    gapBefore: null,
    dirty: true,
    inline: []
  };
  const next = blocks.slice();
  next.splice(at, 0, para);
  return { blocks: clearSeams(next, new Set([id])), caret: { id: para.id, offset: 0 } };
}

// Re-export so callers that need a fresh id for any future split path have it.
export { generateBlockId };
