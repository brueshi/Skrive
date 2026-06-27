// Document-wide range operations (SKR-118, Stage 2). The transforms that splice
// across block boundaries, expressed over the position model: cross-block delete,
// boundary merge (Backspace at a block start / Delete at a block end), and
// type/paste-over-selection (delete then insert). Pure over the block tree.
//
// Scope today: inline-text leaves (paragraph / heading) at any depth, including
// inside lists and blockquotes — the prose cases. code_block / table / image /
// hr / frozen are BARRIERS: a merge across one is refused and a cross-block range
// that includes one is clamped (returns null), so a text edit can never corrupt a
// table or a code block. Those become first-class in a later sub-stage.

import { generateBlockId, type BlockNode, type InlineNode } from '../blockmodel';
import { deleteRangeInInline, inlineLength, insertTextInInline } from './inline-ops';
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
      else if (b.type === 'blockquote') walk(b.children);
      else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        for (const item of b.items) walk(item.children);
      } else out.push({ id: b.id, kind: 'barrier' }); // code_block / table / hr / image / frozen
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
function removeBlocks(blocks: BlockNode[], ids: Set<string>): BlockNode[] {
  const walk = (nodes: BlockNode[]): BlockNode[] => {
    const out: BlockNode[] = [];
    for (const b of nodes) {
      if (ids.has(b.id)) continue;
      if (b.type === 'blockquote') {
        const children = walk(b.children);
        if (children.length === 0) continue; // emptied quote: prune
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

/**
 * Delete the content between two positions in document order. The start leaf
 * keeps its id + type and receives `head(start) + tail(end)`; every block strictly
 * between is removed — including a fully-covered barrier (a divider / code block /
 * table caught entirely inside the selection) — and emptied containers pruned.
 * Both ENDPOINTS must be inline leaves: a range that starts or ends inside a code
 * block / table returns null (clamp), so a text edit never partial-cuts one. Caret
 * lands at the join (`start`).
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
  const si = leaves.findIndex((l) => l.id === startId);
  const ei = leaves.findIndex((l) => l.id === endId);
  if (si < 0 || ei < 0 || si >= ei) return null;

  // Endpoints must be text leaves; a range bounded by a code block / table cell
  // clamps (don't partial-cut one). Barriers fully BETWEEN the ends are removed.
  const startLeaf = inlineLeaf(blocks, startId);
  const endLeaf = inlineLeaf(blocks, endId);
  if (!startLeaf || !endLeaf) return null;

  const merged = [...headOf(startLeaf.inline, startOffset), ...tailOf(endLeaf.inline, endOffset)];
  const removeIds = new Set<string>();
  for (let i = si + 1; i <= ei; i++) removeIds.add(leaves[i]!.id);

  let next = updateBlockById(blocks, startId, (b) => ({ ...b, inline: merged, dirty: true }) as BlockNode);
  next = removeBlocks(next, removeIds);
  return { blocks: next, caret: { id: startId, offset: startOffset } };
}

/** Backspace at the start of an inline leaf: merge it into the previous inline
 *  leaf in document order (across a list / quote boundary). Null when it is the
 *  first leaf, or the previous leaf is a barrier (don't merge into a table/code). */
export function mergeBackward(blocks: BlockNode[], leafId: string): RangeResult | null {
  const leaves = documentLeaves(blocks);
  const i = leaves.findIndex((l) => l.id === leafId);
  if (i <= 0) return null;
  const prev = leaves[i - 1]!;
  if (prev.kind !== 'inline') return null;
  const prevLeaf = inlineLeaf(blocks, prev.id);
  if (!prevLeaf) return null;
  return deleteAcross(blocks, prev.id, inlineLength(prevLeaf.inline), leafId, 0);
}

/** Delete at the end of an inline leaf: pull the next inline leaf up into it.
 *  Null when it is the last leaf, or the next leaf is a barrier. */
export function mergeForward(blocks: BlockNode[], leafId: string): RangeResult | null {
  const leaves = documentLeaves(blocks);
  const i = leaves.findIndex((l) => l.id === leafId);
  if (i < 0 || i >= leaves.length - 1) return null;
  const next = leaves[i + 1]!;
  if (next.kind !== 'inline') return null;
  const cur = inlineLeaf(blocks, leafId);
  if (!cur) return null;
  return deleteAcross(blocks, leafId, inlineLength(cur.inline), next.id, 0);
}

/** Replace a cross-block range with typed/pasted text: delete the range, then
 *  insert `text` at the join. Null when the range clamps (see deleteAcross). */
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
  const inline = insertTextInInline(inlineLeaf(deleted.blocks, startId)!.inline, startOffset, text);
  return {
    blocks: updateBlockById(deleted.blocks, startId, (b) => ({ ...b, inline, dirty: true }) as BlockNode),
    caret: { id: startId, offset: startOffset + text.length }
  };
}

// Re-export so callers that need a fresh id for any future split path have it.
export { generateBlockId };
