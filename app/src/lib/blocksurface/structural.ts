// Nested structural edits (SKR-95, Stage 3f). Enter inside a container behaves
// the way each container expects: in a list it starts a new ITEM, in a quote it
// starts a new paragraph; on an empty nested block it EXITS the container to a
// fresh paragraph after it. Pure transforms over the block tree, returning the
// new top-level blocks plus where the caret should land (a block id + offset).
//
// Scope: one level of containment (quote > block, list > item > block), the shape
// conversions and typing produce. Deeper nesting and Backspace-driven merges are
// a later refinement; this sub-stage makes lists and quotes feel right to write.

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
 * Enter inside a container, splitting at `offset`. Returns null if `id` is not a
 * direct inline-text child of a quote or list item (the caller then handles the
 * top-level / code cases). The original block keeps its id and first half; the new
 * block mints `gen()` and takes the second half.
 */
export function enterInContainer(
  blocks: BlockNode[],
  id: string,
  offset: number,
  gen: () => string
): StructuralResult | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;

    if (b.type === 'blockquote') {
      const ci = b.children.findIndex((c) => c.id === id);
      if (ci >= 0) {
        const child = b.children[ci]!;
        if (!isInlineText(child)) return null;
        const [left, right] = splitInline(child.inline, offset);
        const rightBlock = newParagraph(right, gen());
        const children = b.children.slice();
        children.splice(ci, 1, { ...child, inline: left, dirty: true }, rightBlock);
        const out = blocks.slice();
        out[i] = { ...b, children, dirty: true };
        return { blocks: out, caret: { id: rightBlock.id, offset: 0 } };
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
          // The content before the caret stays in this item; the content after
          // (and any following blocks in the item) opens a new item.
          const leftChildren = [...item.children.slice(0, ci), { ...child, inline: left, dirty: true }];
          const rightChildren = [rightPara, ...item.children.slice(ci + 1)];
          const items = b.items.slice();
          items.splice(k, 1, { ...item, children: leftChildren }, { spread: item.spread, children: rightChildren });
          const out = blocks.slice();
          out[i] = { ...b, items, dirty: true };
          return { blocks: out, caret: { id: rightPara.id, offset: 0 } };
        }
      }
    }
  }
  return null;
}

/**
 * Exit a container: remove the (empty) block `id` from its quote/list and drop a
 * fresh paragraph after the container — the universal "press Enter on a blank line
 * to leave the list". If the container empties, it is replaced by the paragraph.
 * Returns null if `id` is not a direct child of a quote or list item.
 */
export function exitContainer(blocks: BlockNode[], id: string, gen: () => string): StructuralResult | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const para = newParagraph([], gen());

    if (b.type === 'blockquote') {
      const ci = b.children.findIndex((c) => c.id === id);
      if (ci >= 0) {
        const children = b.children.slice();
        children.splice(ci, 1);
        const out = blocks.slice();
        if (children.length === 0) out.splice(i, 1, para);
        else {
          out[i] = { ...b, children, dirty: true };
          out.splice(i + 1, 0, para);
        }
        return { blocks: out, caret: { id: para.id, offset: 0 } };
      }
    } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
      for (let k = 0; k < b.items.length; k++) {
        const item = b.items[k]!;
        if (item.children.some((c) => c.id === id)) {
          const items = b.items.slice();
          items.splice(k, 1);
          const out = blocks.slice();
          if (items.length === 0) out.splice(i, 1, para);
          else {
            out[i] = { ...b, items, dirty: true };
            out.splice(i + 1, 0, para);
          }
          return { blocks: out, caret: { id: para.id, offset: 0 } };
        }
      }
    }
  }
  return null;
}
