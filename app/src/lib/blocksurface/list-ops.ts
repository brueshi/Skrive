// List structural ergonomics (SKR-112, Stage 4). Pure transforms over the block
// tree for Tab/Shift+Tab nesting and the list keyboard shortcuts, in the same
// shape as structural.ts: take the current blocks plus the focused leaf id, return
// the new blocks (or null when the op does not apply / is a no-op). The caller
// re-renders and restores the caret on the same leaf id — every op here PRESERVES
// the focused leaf's id and content, so its caret offset stays valid.
//
// Nesting is already representable in the model: a list item's `children` is a
// BlockNode[], so a nested list is just a list block sitting inside an item. The
// renderer (renderChildren into <li>) and serializer (canonicalBlock recursion
// with marker-width indentation) already round-trip that shape — this file only
// adds the editing operations that produce and unwind it. The transforms recurse,
// so depth > 1 works without special-casing.

import type { BlockNode, BulletListBlock, ListItem, OrderedListBlock } from '../blockmodel';

type ListBlock = BulletListBlock | OrderedListBlock;

function isList(b: BlockNode): b is ListBlock {
  return b.type === 'bullet_list' || b.type === 'ordered_list';
}

/** True when the item's text leaf (a direct child) is the focused block. The
 *  focused paragraph is always a direct child of exactly one item; nested lists
 *  are other children, so this identifies the leaf's IMMEDIATE item. */
function itemHasLeaf(item: ListItem, leafId: string): boolean {
  return item.children.some((c) => c.id === leafId);
}

/** A fresh list block of the same kind (and marker/delimiter) as `template`,
 *  carrying `items`. `start` is the number the first item should carry — 1 for a
 *  freshly opened sublist, `template.start + <items consumed before these>` for a
 *  fragment that continues the template's numbering (SKR-181); it is ignored for
 *  bullet lists. `id` defaults to a freshly minted one; pass an explicit id to keep
 *  identity stable when a list is merely re-split. */
function listLike(
  template: ListBlock,
  items: ListItem[],
  gen: () => string,
  start: number,
  id?: string
): ListBlock {
  const base = { id: id ?? gen(), durable: false, src: null, gapBefore: null, dirty: true };
  if (template.type === 'ordered_list') {
    return { type: 'ordered_list', ...base, start, delimiter: template.delimiter, spread: template.spread, items };
  }
  return { type: 'bullet_list', ...base, marker: template.marker, spread: template.spread, items };
}

/** The number the item at `index` carries in `list` — the serializer numbers items
 *  positionally from `start`, so this is the only place the arithmetic lives. */
function numberAt(list: ListBlock, index: number): number {
  return (list.type === 'ordered_list' ? list.start : 1) + index;
}

/** The list whose item DIRECTLY contains the focused leaf, or null. Used to read
 *  the immediate list's type for the toggle shortcut. */
export function findImmediateList(blocks: BlockNode[], leafId: string): ListBlock | null {
  for (const b of blocks) {
    if (isList(b)) {
      for (const item of b.items) {
        if (itemHasLeaf(item, leafId)) return b;
        const nested = findImmediateList(item.children, leafId);
        if (nested) return nested;
      }
    } else if (b.type === 'blockquote') {
      const nested = findImmediateList(b.children, leafId);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Tab: nest the focused item under its previous sibling. The op runs at the
 * deepest list that holds the leaf's item directly; the moved item joins the
 * previous sibling's trailing same-kind sublist (creating one if absent). Returns
 * null when the item is first in its list (nothing to nest under) or not in a list.
 */
export function indentItem(blocks: BlockNode[], leafId: string, gen: () => string): BlockNode[] | null {
  return recurse(blocks);

  function recurse(nodes: BlockNode[]): BlockNode[] | null {
    for (let i = 0; i < nodes.length; i++) {
      const b = nodes[i]!;
      if (isList(b)) {
        for (let k = 0; k < b.items.length; k++) {
          const item = b.items[k]!;
          if (itemHasLeaf(item, leafId)) {
            if (k === 0) return null; // no previous sibling to nest under
            const prev = b.items[k - 1]!;
            // Spread-copy so task-list state (checked) travels with the item.
            const moving: ListItem = { ...item };
            const last = prev.children[prev.children.length - 1];
            const prevChildren =
              last && isList(last) && last.type === b.type
                ? [...prev.children.slice(0, -1), { ...last, items: [...last.items, moving], dirty: true }]
                : [...prev.children, listLike(b, [moving], gen, 1)]; // a new sublist opens at 1
            const items = b.items.slice();
            items.splice(k - 1, 2, { ...prev, children: prevChildren });
            const out = nodes.slice();
            out[i] = { ...b, items, dirty: true };
            return out;
          }
          const r = recurse(item.children);
          if (r) {
            const items = b.items.slice();
            items[k] = { ...item, children: r };
            const out = nodes.slice();
            out[i] = { ...b, items, dirty: true };
            return out;
          }
        }
      } else if (b.type === 'blockquote') {
        const r = recurse(b.children);
        if (r) {
          const out = nodes.slice();
          out[i] = { ...b, children: r, dirty: true };
          return out;
        }
      }
    }
    return null;
  }
}

/**
 * Shift+Tab on a NESTED item: lift it one level, to the parent list as the
 * sibling after its parent item. Items that followed it in the sublist re-home
 * under the lifted item (preserving document order); items before it stay; an
 * emptied sublist is removed. Returns null when the item has no parent list (a
 * top-level item — handled by liftItemOut instead).
 */
export function outdentItem(blocks: BlockNode[], leafId: string, gen: () => string): BlockNode[] | null {
  return recurse(blocks);

  function recurse(nodes: BlockNode[]): BlockNode[] | null {
    for (let i = 0; i < nodes.length; i++) {
      const b = nodes[i]!;
      if (isList(b)) {
        for (let pk = 0; pk < b.items.length; pk++) {
          const parentItem = b.items[pk]!;
          for (let ci = 0; ci < parentItem.children.length; ci++) {
            const child = parentItem.children[ci]!;
            if (!isList(child)) continue;
            const k = child.items.findIndex((it) => itemHasLeaf(it, leafId));
            if (k < 0) continue;
            // Found: lift child.items[k] from the sublist into b after parentItem.
            const lifted = child.items[k]!;
            const before = child.items.slice(0, k);
            const after = child.items.slice(k + 1);
            // The re-homed trailing siblings stay at the sublist's visual depth, so
            // they keep counting from where they were (SKR-181).
            const liftedChildren =
              after.length > 0
                ? [...lifted.children, listLike(child, after, gen, numberAt(child, k + 1))]
                : lifted.children.slice();
            // Spread-copy so task-list state (checked) survives the lift.
            const liftedItem: ListItem = { ...lifted, children: liftedChildren };
            const parentChildren =
              before.length > 0
                ? parentItem.children.map((c, idx) => (idx === ci ? { ...child, items: before, dirty: true } : c))
                : [...parentItem.children.slice(0, ci), ...parentItem.children.slice(ci + 1)];
            const items = b.items.slice();
            items.splice(pk, 1, { ...parentItem, children: parentChildren }, liftedItem);
            const out = nodes.slice();
            out[i] = { ...b, items, dirty: true };
            return out;
          }
          // Not directly under this item; the parent list may be deeper.
          const r = recurse(parentItem.children);
          if (r) {
            const items = b.items.slice();
            items[pk] = { ...parentItem, children: r };
            const out = nodes.slice();
            out[i] = { ...b, items, dirty: true };
            return out;
          }
        }
      } else if (b.type === 'blockquote') {
        const r = recurse(b.children);
        if (r) {
          const out = nodes.slice();
          out[i] = { ...b, children: r, dirty: true };
          return out;
        }
      }
    }
    return null;
  }
}

/**
 * Shift+Tab / toggle-off on a TOP-LEVEL item: remove it from the list, dropping
 * its child blocks in as top-level blocks where the list was, splitting the list
 * into before/after fragments around them. The focused leaf keeps its id (so the
 * caller restores the caret); the surviving fragments keep stable ids where
 * possible. Returns null when the leaf is not a direct item of a top-level list.
 *
 * Named `…Out`, not `…ToParagraph`: the lifted children keep their own types, so
 * an item holding a heading lifts out as a heading.
 */
export function liftItemOut(blocks: BlockNode[], leafId: string, gen: () => string): BlockNode[] | null {
  return recurse(blocks);

  function recurse(nodes: BlockNode[]): BlockNode[] | null {
    for (let i = 0; i < nodes.length; i++) {
      const b = nodes[i]!;
      if (isList(b)) {
        const k = b.items.findIndex((it) => itemHasLeaf(it, leafId));
        if (k >= 0) {
          const item = b.items[k]!;
          const before = b.items.slice(0, k);
          const after = b.items.slice(k + 1);
          const replacement: BlockNode[] = [];
          // Reuse the list's id for one surviving fragment so a durable list keeps
          // its identity; the other fragment, when both exist, mints a fresh id.
          // The before-fragment keeps the original numbering; the after-fragment
          // resumes past the lifted item, so `3./4./5.` minus the middle item reads
          // `3.` … `5.` and not `1.` … `1.` (SKR-181).
          if (before.length > 0) replacement.push(listLike(b, before, gen, numberAt(b, 0), b.id));
          for (const child of item.children) {
            replacement.push(child.type === 'frozen_block' ? child : { ...child, dirty: true });
          }
          if (after.length > 0) {
            // Caveat: when the lifted item's only child is itself a list, the three
            // fragments land adjacent and same-markered, so the Markdown floor
            // re-parses them as ONE list on reload — the in-session split is not
            // representable there. `.folio` keeps the blocks distinct.
            replacement.push(listLike(b, after, gen, numberAt(b, k + 1), before.length > 0 ? undefined : b.id));
          }
          const out = nodes.slice();
          out.splice(i, 1, ...replacement);
          return out;
        }
      } else if (b.type === 'blockquote') {
        const r = recurse(b.children);
        if (r) {
          const out = nodes.slice();
          out[i] = { ...b, children: r, dirty: true };
          return out;
        }
      }
    }
    return null;
  }
}

/**
 * Toggle shortcut switching list kind: change the immediate list (the one whose
 * item directly holds the leaf) to `target`, keeping its items and id. Returns
 * null when the leaf is not in a list.
 *
 * The toggle is deliberately memoryless (SKR-181): a kind change normalizes style,
 * so `3) one` -> bullet -> ordered comes back as `1. one`, and undo is the way to
 * recover the original. Carrying the counterpart kind's style across the toggle
 * would only survive in memory — `.folio`, the native format, persists `start` but
 * not `delimiter` or `marker`, so a round trip would be lossless in-session and
 * lossy after a reload. Numbering that IS structural (list splits, item lifts) is
 * preserved by the ops above.
 */
export function changeListType(
  blocks: BlockNode[],
  leafId: string,
  target: 'bullet_list' | 'ordered_list'
): BlockNode[] | null {
  return recurse(blocks);

  function recurse(nodes: BlockNode[]): BlockNode[] | null {
    for (let i = 0; i < nodes.length; i++) {
      const b = nodes[i]!;
      if (isList(b)) {
        if (b.type !== target && b.items.some((it) => itemHasLeaf(it, leafId))) {
          const base = { id: b.id, durable: b.durable, src: null, gapBefore: b.gapBefore, dirty: true };
          const next: ListBlock =
            target === 'ordered_list'
              ? { type: 'ordered_list', ...base, start: 1, delimiter: '.', spread: b.spread, items: b.items }
              : { type: 'bullet_list', ...base, marker: '-', spread: b.spread, items: b.items };
          const out = nodes.slice();
          out[i] = next;
          return out;
        }
        for (let k = 0; k < b.items.length; k++) {
          const item = b.items[k]!;
          const r = recurse(item.children);
          if (r) {
            const items = b.items.slice();
            items[k] = { ...item, children: r };
            const out = nodes.slice();
            out[i] = { ...b, items, dirty: true };
            return out;
          }
        }
      } else if (b.type === 'blockquote') {
        const r = recurse(b.children);
        if (r) {
          const out = nodes.slice();
          out[i] = { ...b, children: r, dirty: true };
          return out;
        }
      }
    }
    return null;
  }
}
