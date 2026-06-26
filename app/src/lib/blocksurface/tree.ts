// Block-tree addressing (SKR-95, Stage 3e). The hot path edits the focused leaf
// block, which may be nested inside a container (a paragraph in a blockquote, a
// list item's paragraph). These pure transforms find and update a block by id
// anywhere in the tree, marking every ancestor container dirty so the container
// re-serializes canonically with the change (its children carry no per-block src
// of their own).
//
// Stage 3e covers nested INLINE editing (type / format / delete). Nested
// STRUCTURAL edits (Enter making a list item, exiting a container) and tables are
// Stage 3f; this file deliberately only does find + in-place update.

import type { BlockNode } from '../blockmodel';

/** Find a block by id anywhere in the tree (top-level or nested), or null. */
export function findBlockById(blocks: BlockNode[], id: string): BlockNode | null {
  for (const block of blocks) {
    if (block.id === id) return block;
    if (block.type === 'blockquote') {
      const hit = findBlockById(block.children, id);
      if (hit) return hit;
    } else if (block.type === 'bullet_list' || block.type === 'ordered_list') {
      for (const item of block.items) {
        const hit = findBlockById(item.children, id);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// Rewrite the first block matching `id` via `fn`, returning the new array and
// whether anything changed. A container whose descendant changed is itself
// returned dirty (so it re-serializes canonically around the edit).
function rewrite(blocks: BlockNode[], id: string, fn: (b: BlockNode) => BlockNode): { blocks: BlockNode[]; changed: boolean } {
  let changed = false;
  const out = blocks.map((block) => {
    if (changed) return block;
    if (block.id === id) {
      changed = true;
      return fn(block);
    }
    if (block.type === 'blockquote') {
      const r = rewrite(block.children, id, fn);
      if (r.changed) {
        changed = true;
        return { ...block, children: r.blocks, dirty: true };
      }
    } else if (block.type === 'bullet_list' || block.type === 'ordered_list') {
      let itemChanged = false;
      const items = block.items.map((item) => {
        if (itemChanged) return item;
        const r = rewrite(item.children, id, fn);
        if (r.changed) {
          itemChanged = true;
          return { ...item, children: r.blocks };
        }
        return item;
      });
      if (itemChanged) {
        changed = true;
        return { ...block, items, dirty: true };
      }
    }
    return block;
  });
  return { blocks: out, changed };
}

/** Replace the block with `id` (nested or top-level) by applying `fn`. `fn` is
 *  responsible for marking the leaf dirty; ancestors are marked dirty here. */
export function updateBlockById(blocks: BlockNode[], id: string, fn: (b: BlockNode) => BlockNode): BlockNode[] {
  return rewrite(blocks, id, fn).blocks;
}
