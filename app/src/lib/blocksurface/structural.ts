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

import { deleteRangeInInline, inlineLength, splitInline } from './inline-ops';
import type { BlockNode, InlineNode } from '../blockmodel';

export type StructuralResult = { blocks: BlockNode[]; caret: { id: string; offset: number } };

type InlineTextBlock = Extract<BlockNode, { type: 'paragraph' | 'heading' }>;

function newParagraph(inline: InlineNode[], id: string): BlockNode {
  return { type: 'paragraph', id, durable: false, src: null, gapBefore: null, dirty: true, inline };
}

function isInlineText(b: BlockNode): b is InlineTextBlock {
  return b.type === 'paragraph' || b.type === 'heading';
}

/**
 * The two halves an Enter splits a block into, with the SAME type rules the
 * top-level path applies (surface.ts applyEnter) — a container is not a different
 * editor. Enter at the END of a heading drops to body text; Enter at its START
 * pushes the heading down and leaves an empty paragraph above; splitting mid-heading
 * keeps the heading on both sides. Before SKR-180 the container path hardcoded a
 * paragraph for the right half, so splitting a heading inside a quote demoted its
 * tail while the identical gesture at the top level did not.
 *
 * A non-collapsed [start, end) is deleted first, exactly as the top-level path does.
 * The container path used to pass only `start`, so the selected text was never
 * removed — it survived in the right half and was DUPLICATED into both.
 */
export function splitBlockAt(
  child: InlineTextBlock,
  start: number,
  end: number,
  gen: () => string
): { left: BlockNode; right: BlockNode } {
  const inline = start === end ? child.inline : deleteRangeInInline(child.inline, start, end);
  const [leftInline, rightInline] = splitInline(inline, start);
  const heading = child.type === 'heading';
  const emptyLeft = inlineLength(leftInline) === 0;
  const emptyRight = inlineLength(rightInline) === 0;

  // The two heading rules are NOT mirror images, and writing them as one symmetric
  // rule gets the empty-heading case wrong.
  //
  // Right: Enter at the END of a heading always drops to body text. Unconditional.
  // Left:  Enter at the START of a heading pushes the heading down and leaves an
  //        empty paragraph above — but only when there IS a heading being pushed
  //        down. Press Enter on a heading you just created and left/right are both
  //        empty; demoting the left would silently erase the heading. So the left
  //        rule is guarded on the right half carrying the text.
  const demoteLeft = heading && emptyLeft && !emptyRight;
  const demoteRight = heading && emptyRight;

  const left: BlockNode = demoteLeft
    ? newParagraph(leftInline, child.id)
    : { ...child, inline: leftInline, dirty: true };
  // The right half is a NEW block: fresh id, no durable source text to reuse.
  const right: BlockNode = demoteRight
    ? newParagraph(rightInline, gen())
    : { ...child, id: gen(), durable: false, src: null, gapBefore: null, inline: rightInline, dirty: true };
  return { left, right };
}

/**
 * Enter inside a container, splitting at `start` and first deleting `[start, end)`.
 * Returns null if `id` is not an inline-text child of a quote or list item anywhere
 * in the tree (the caller then handles the top-level / code cases). The original
 * block keeps its id and first half; the new block mints `gen()` and takes the
 * second half, preserving the block's type per `splitBlockAt`.
 */
export function enterInContainer(
  blocks: BlockNode[],
  id: string,
  start: number,
  end: number,
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
          const { left, right } = splitBlockAt(child, start, end, gen);
          const children = b.children.slice();
          children.splice(ci, 1, left, right);
          caret.id = right.id;
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
            const { left, right } = splitBlockAt(child, start, end, gen);
            // Content before the caret stays in this item; content after (and any
            // following blocks in the item) opens a new item at the same depth.
            const leftChildren = [...item.children.slice(0, ci), left];
            const rightChildren = [right, ...item.children.slice(ci + 1)];
            const items = b.items.slice();
            items.splice(k, 1, { ...item, children: leftChildren }, { spread: item.spread, children: rightChildren });
            caret.id = right.id;
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
          // The blank line becomes a paragraph WHERE IT IS, splitting the quote
          // around it. It used to be deleted and a paragraph appended after the whole
          // quote, which teleported the caret past text the writer had not finished
          // with — an empty line between two quoted paragraphs stranded the second one
          // above the caret (SKR-180). A list already splits around a lifted item
          // (SKR-222's splitListAround); a quote is the same shape.
          //
          // The common gestures are unchanged, because they are the degenerate cases:
          // an empty LAST child leaves `after` empty (quote, then paragraph — the
          // "Enter twice to leave a quote" move), and a lone empty child leaves both
          // sides empty (the paragraph replaces the quote).
          const para = newParagraph([], gen());
          caret.id = para.id;
          const before = b.children.slice(0, ci);
          const after = b.children.slice(ci + 1);
          const replacement: BlockNode[] = [];
          if (before.length > 0) replacement.push({ ...b, children: before, dirty: true });
          replacement.push(para);
          // The tail is a NEW quote: it cannot reuse the id or the verbatim source of
          // the one it was split out of.
          if (after.length > 0) {
            replacement.push({ ...b, id: gen(), durable: false, src: null, gapBefore: null, children: after, dirty: true });
          }
          const out = nodes.slice();
          out.splice(i, 1, ...replacement);
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
