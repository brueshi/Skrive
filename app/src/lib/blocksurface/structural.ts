// Nested structural edits (SKR-95, Stage 3f; recursion SKR-112 follow-up). Enter
// inside a container behaves the way each container expects: in a list it starts a
// new ITEM, in a quote it starts a new paragraph; on an empty nested block it
// EXITS the container to a fresh paragraph after it. Pure transforms over the
// block tree, returning the new top-level blocks plus where the caret should land
// (a block id + offset).
//
// These recurse, so they reach a block at ANY depth — a paragraph inside a nested
// list (list > item > nested list > item > paragraph), not just one level down.
// The one-level version silently no-op'd on nested items once list nesting landed
// (SKR-112), which read as "Enter is disabled" inside a sublist.

import { splitInline } from './inline-ops';
import type { BlockNode, InlineNode } from '../blockmodel';

export type StructuralResult = { blocks: BlockNode[]; caret: { id: string; offset: number } };

function newParagraph(inline: InlineNode[], id: string): BlockNode {
  return { type: 'paragraph', id, durable: false, src: null, gapBefore: null, dirty: true, inline };
}

function isInlineText(b: BlockNode): b is Extract<BlockNode, { type: 'paragraph' | 'heading' }> {
  return b.type === 'paragraph' || b.type === 'heading';
}

/**
 * Enter inside a container, splitting at `offset`. Returns null if `id` is not an
 * inline-text child of a quote or list item anywhere in the tree (the caller then
 * handles the top-level / code cases). The original block keeps its id and first
 * half; the new block mints `gen()` and takes the second half.
 */
export function enterInContainer(
  blocks: BlockNode[],
  id: string,
  offset: number,
  gen: () => string
): StructuralResult | null {
  const caret = { id: '', offset: 0 };
  const out = recurse(blocks);
  return out ? { blocks: out, caret } : null;

  function recurse(nodes: BlockNode[]): BlockNode[] | null {
    for (let i = 0; i < nodes.length; i++) {
      const b = nodes[i]!;
      if (b.type === 'blockquote') {
        const ci = b.children.findIndex((c) => c.id === id);
        if (ci >= 0) {
          const child = b.children[ci]!;
          if (!isInlineText(child)) return null;
          const [left, right] = splitInline(child.inline, offset);
          const rightBlock = newParagraph(right, gen());
          const children = b.children.slice();
          children.splice(ci, 1, { ...child, inline: left, dirty: true }, rightBlock);
          caret.id = rightBlock.id;
          const out = nodes.slice();
          out[i] = { ...b, children, dirty: true };
          return out;
        }
        const r = recurse(b.children);
        if (r) {
          const out = nodes.slice();
          out[i] = { ...b, children: r, dirty: true };
          return out;
        }
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        for (let k = 0; k < b.items.length; k++) {
          const item = b.items[k]!;
          const ci = item.children.findIndex((c) => c.id === id);
          if (ci >= 0) {
            const child = item.children[ci]!;
            if (!isInlineText(child)) return null;
            const [left, right] = splitInline(child.inline, offset);
            const rightPara = newParagraph(right, gen());
            // Content before the caret stays in this item; content after (and any
            // following blocks in the item) opens a new item at the same depth.
            const leftChildren = [...item.children.slice(0, ci), { ...child, inline: left, dirty: true }];
            const rightChildren = [rightPara, ...item.children.slice(ci + 1)];
            const items = b.items.slice();
            items.splice(k, 1, { ...item, children: leftChildren }, { spread: item.spread, children: rightChildren });
            caret.id = rightPara.id;
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
      }
    }
    return null;
  }
}

/**
 * Exit a container: remove the (empty) block `id` from its quote/list and drop a
 * fresh paragraph after the container — the universal "press Enter on a blank line
 * to leave the container". Recurses, so it finds the block at any depth and exits
 * at that level. If the container empties, it is replaced by the paragraph.
 * Returns null if `id` is not a direct child of a quote or list item.
 */
export function exitContainer(blocks: BlockNode[], id: string, gen: () => string): StructuralResult | null {
  const caret = { id: '', offset: 0 };
  const out = recurse(blocks);
  return out ? { blocks: out, caret } : null;

  function recurse(nodes: BlockNode[]): BlockNode[] | null {
    for (let i = 0; i < nodes.length; i++) {
      const b = nodes[i]!;
      if (b.type === 'blockquote') {
        const ci = b.children.findIndex((c) => c.id === id);
        if (ci >= 0) {
          const para = newParagraph([], gen());
          caret.id = para.id;
          const children = b.children.slice();
          children.splice(ci, 1);
          const out = nodes.slice();
          if (children.length === 0) out.splice(i, 1, para);
          else {
            out[i] = { ...b, children, dirty: true };
            out.splice(i + 1, 0, para);
          }
          return out;
        }
        const r = recurse(b.children);
        if (r) {
          const out = nodes.slice();
          out[i] = { ...b, children: r, dirty: true };
          return out;
        }
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        for (let k = 0; k < b.items.length; k++) {
          const item = b.items[k]!;
          if (item.children.some((c) => c.id === id)) {
            const para = newParagraph([], gen());
            caret.id = para.id;
            const items = b.items.slice();
            items.splice(k, 1);
            const out = nodes.slice();
            if (items.length === 0) out.splice(i, 1, para);
            else {
              out[i] = { ...b, items, dirty: true };
              out.splice(i + 1, 0, para);
            }
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
      }
    }
    return null;
  }
}
