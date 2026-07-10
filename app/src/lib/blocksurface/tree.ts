// Block-tree addressing (SKR-95, Stage 3e). The hot path edits the focused leaf
// block, which may be nested inside a container (a paragraph in a blockquote, a
// list item's paragraph). These pure transforms find and update a block by id
// anywhere in the tree, marking every ancestor container dirty so the container
// re-serializes canonically with the change (its children carry no per-block src
// of their own).
//
// Addressing is backed by a memoized id -> top-level-index map (SKR-190): every
// lookup against the same blocks array reuses one O(document) build, so
// findBlockById / updateBlockById cost O(depth of one top-level block), not
// O(document). The memo is sound because the model is immutable-by-convention —
// a blocks array's contents never change after construction — and it is keyed
// by array identity in a WeakMap, so history snapshots keep their own maps.

import type { BlockNode } from '../blockmodel';

const indexCache = new WeakMap<readonly BlockNode[], Map<string, number>>();

function indexSubtree(block: BlockNode, top: number, out: Map<string, number>): void {
  // First occurrence wins, matching find-first semantics on a duplicate id.
  if (!out.has(block.id)) out.set(block.id, top);
  if (block.type === 'blockquote') {
    for (const child of block.children) indexSubtree(child, top, out);
  } else if (block.type === 'bullet_list' || block.type === 'ordered_list') {
    for (const item of block.items) for (const child of item.children) indexSubtree(child, top, out);
  }
}

/** The id -> top-level-index map for a blocks array: every block id in the tree
 *  (top-level or nested) maps to the index of the top-level block containing it.
 *  Built once per array identity and memoized. */
export function blockIndexOf(blocks: readonly BlockNode[]): ReadonlyMap<string, number> {
  let map = indexCache.get(blocks);
  if (!map) {
    map = new Map<string, number>();
    for (let i = 0; i < blocks.length; i++) indexSubtree(blocks[i]!, i, map);
    indexCache.set(blocks, map);
  }
  return map;
}

function findInBlock(block: BlockNode, id: string): BlockNode | null {
  if (block.id === id) return block;
  if (block.type === 'blockquote') {
    for (const child of block.children) {
      const hit = findInBlock(child, id);
      if (hit) return hit;
    }
  } else if (block.type === 'bullet_list' || block.type === 'ordered_list') {
    for (const item of block.items) {
      for (const child of item.children) {
        const hit = findInBlock(child, id);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Find a block by id anywhere in the tree (top-level or nested), or null. */
export function findBlockById(blocks: BlockNode[], id: string): BlockNode | null {
  const i = blockIndexOf(blocks).get(id);
  if (i === undefined) return null;
  return findInBlock(blocks[i]!, id);
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

/** Apply `fn` to the block with `id` within a single top-level block's subtree.
 *  Returns `top` unchanged (same object) when `id` is not in the subtree, so
 *  batch callers can rewrite several leaves into one sliced array without an
 *  O(document) pass per leaf (SKR-190). */
export function updateBlockInTop(top: BlockNode, id: string, fn: (b: BlockNode) => BlockNode): BlockNode {
  const r = rewrite([top], id, fn);
  return r.changed ? r.blocks[0]! : top;
}

/** Whether two subtrees carry exactly the same block ids in the same shape —
 *  the condition under which an edited array can share its predecessor's
 *  id -> index map instead of rebuilding it O(document) on the next lookup. */
function sameIds(a: BlockNode, b: BlockNode): boolean {
  if (a === b) return true;
  if (a.id !== b.id) return false;
  if (a.type === 'blockquote' && b.type === 'blockquote') {
    if (a.children.length !== b.children.length) return false;
    for (let i = 0; i < a.children.length; i++) {
      if (!sameIds(a.children[i]!, b.children[i]!)) return false;
    }
    return true;
  }
  if (a.type === 'blockquote' || b.type === 'blockquote') return false;
  if (
    (a.type === 'bullet_list' || a.type === 'ordered_list') &&
    (b.type === 'bullet_list' || b.type === 'ordered_list')
  ) {
    if (a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) {
      const ac = a.items[i]!.children;
      const bc = b.items[i]!.children;
      if (ac.length !== bc.length) return false;
      for (let j = 0; j < ac.length; j++) {
        if (!sameIds(ac[j]!, bc[j]!)) return false;
      }
    }
    return true;
  }
  if (a.type === 'bullet_list' || a.type === 'ordered_list' || b.type === 'bullet_list' || b.type === 'ordered_list') {
    return false;
  }
  return true;
}

/** Replace the block with `id` (nested or top-level) by applying `fn`. `fn` is
 *  responsible for marking the leaf dirty; ancestors are marked dirty here.
 *  O(depth of the containing top-level block) plus one pointer-copy of the
 *  top-level array — never a full-tree walk (SKR-190). Returns `blocks`
 *  unchanged when `id` is not in the tree. */
export function updateBlockById(blocks: BlockNode[], id: string, fn: (b: BlockNode) => BlockNode): BlockNode[] {
  const index = blockIndexOf(blocks);
  const i = index.get(id);
  if (i === undefined) return blocks;
  const top = blocks[i]!;
  const updated = updateBlockInTop(top, id, fn);
  const out = blocks.slice();
  out[i] = updated;
  // Typing-path fast lane: an edit that preserved every id in the subtree (the
  // overwhelmingly common case) leaves the id -> index map identical, so the new
  // array shares it instead of paying an O(document) rebuild per keystroke.
  if (sameIds(top, updated)) indexCache.set(out, index as Map<string, number>);
  return out;
}
