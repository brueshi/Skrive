// The idempotence guard — substrate-independent. This is the heart of the
// faithful round-trip: two Markdown strings are "semantically equal" when they
// parse to the same mdast tree (ignoring source positions), which is what lets
// edit-then-revert restore the original bytes instead of baking in
// normalization. Both the projection serializer (PM) and the block serializer
// share this one implementation so they can never disagree about what an edit
// preserved.

import type { Root } from 'mdast';
import { parseMarkdown } from './mdast';

// Structural mdast equality ignoring `position`. Short-circuits on the first
// difference and allocates nothing. This replaces a
// `JSON.stringify(stripPositions(tree))` compare that cloned a whole
// position-stripped tree and serialized two trees to strings — three tree-sized
// allocations that were the dominant GC fuel in a snapshot. Key order is ignored,
// so it is at least as permissive as the old string compare (both operands come
// from the same parser, so order matched anyway).
// Exported for the dirty-corpus fidelity gate, which asserts exactly this
// relation between a fully-dirtied serialization and the original document.
export function mdastEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!mdastEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k in ao) {
      if (k === 'position') continue;
      if (!mdastEqual(ao[k], bo[k])) return false;
    }
    for (const k in bo) {
      if (k === 'position') continue;
      if (!(k in ao)) return false;
    }
    return true;
  }
  return false;
}

// Both guard operands cache their parsed trees by string, bounded by a coarse
// clear so a long session can't grow them without limit; they are pure perf
// caches, so dropping entries only costs a re-parse (mdastEqual only reads the
// trees, never mutates). The two operands live in separate maps because their
// lifetimes differ: a block's `src` is stable for as long as the block is being
// edited and its entry is hit on every snapshot, while the `canonical` side
// churns with the content — caching it converts the recurring forms
// (type-then-undo loops, several blocks sharing one canonical shape,
// re-serialization after a surface switch) into hits without ever evicting the
// long-lived src entries.
const TREE_CACHE_LIMIT = 1024;
const srcTreeCache = new Map<string, Root>();
const canonicalTreeCache = new Map<string, Root>();
function cachedTree(cache: Map<string, Root>, md: string): Root {
  const hit = cache.get(md);
  if (hit !== undefined) return hit;
  const tree = parseMarkdown(md);
  if (cache.size >= TREE_CACHE_LIMIT) cache.clear();
  cache.set(md, tree);
  return tree;
}

// Two Markdown strings are "semantically equal" when they parse to the same mdast
// tree (ignoring source positions). This is what lets edit-then-revert restore
// the original bytes instead of baking in normalization.
export function semanticallyEqual(canonical: string, src: string): boolean {
  return mdastEqual(cachedTree(canonicalTreeCache, canonical), cachedTree(srcTreeCache, src));
}
