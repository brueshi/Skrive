// Structure-preserving paste placement (SKR-174 / F25). Two pure transforms over
// the block tree that keep a paste from flattening to space-joined text:
//
//   - spliceParsedAtLeaf: replace an inline-text leaf with its split halves plus
//     the pasted blocks between them, honouring the caret block's identity (a
//     heading never demotes to a paragraph, and pasting at a heading's start
//     lands the blocks BEFORE the heading rather than fusing "para2Title").
//   - graftIntoContainer: paste into a list item / blockquote WITHOUT flattening —
//     pasted list content and paragraphs become sibling list items; blocks join a
//     blockquote's children; anything a container can't hold (table / code / rule /
//     frozen) splits out AFTER the enclosing top-level container, in document order.
//
// Both mirror structural.ts's shape: take the current blocks plus the caret leaf
// and return new blocks + where the caret should land. They never mutate input.

import { inlineLength, splitInline } from './inline-ops';
import type { BlockNode, InlineNode, ListItem } from '../blockmodel';
import type { StructuralResult } from './structural';

type InlineTextBlock = Extract<BlockNode, { type: 'paragraph' | 'heading' }>;
type ContainerBlock = Extract<BlockNode, { type: 'blockquote' | 'bullet_list' | 'ordered_list' }>;

function isInlineText(b: BlockNode): b is InlineTextBlock {
  return b.type === 'paragraph' || b.type === 'heading';
}
function isList(b: BlockNode): b is Extract<BlockNode, { type: 'bullet_list' | 'ordered_list' }> {
  return b.type === 'bullet_list' || b.type === 'ordered_list';
}
function isContainer(b: BlockNode): b is ContainerBlock {
  return b.type === 'blockquote' || isList(b);
}

/** True for blocks a list item / blockquote cannot cleanly hold, so a paste splits
 *  them out after the enclosing top-level container rather than nesting them. */
function splitsOut(b: BlockNode): boolean {
  return b.type === 'table' || b.type === 'code_block' || b.type === 'horizontal_rule' || b.type === 'frozen_block';
}

function newInline(type: 'paragraph' | 'heading', inline: InlineNode[], level: number, gen: () => string): BlockNode {
  const base = { id: gen(), durable: false, src: null, gapBefore: null, dirty: true };
  return type === 'heading' ? { type: 'heading', ...base, level, inline } : { type: 'paragraph', ...base, inline };
}

/** The deepest last inline-text leaf in `blocks`, for landing the caret at the end
 *  of grafted content. Null when the run holds no inline-text leaf at all. */
function lastInlineLeaf(blocks: BlockNode[]): { id: string; offset: number } | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (isInlineText(b)) return { id: b.id, offset: inlineLength(b.inline) };
    if (b.type === 'blockquote') {
      const hit = lastInlineLeaf(b.children);
      if (hit) return hit;
    } else if (isList(b)) {
      for (let k = b.items.length - 1; k >= 0; k--) {
        const hit = lastInlineLeaf(b.items[k]!.children);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * Replace the inline-text `leaf` (split at `offset`) with the pasted `place`
 * blocks between its two halves. The caret block keeps its own type: a leading
 * pasted paragraph merges into the head, a trailing pasted paragraph merges into
 * the tail ONLY when the caret block is a paragraph, and a heading's tail always
 * stays a heading. Pasting at a heading's start inserts the blocks before the
 * (intact) heading. Returns the replacement block run and the caret.
 */
export function spliceParsedAtLeaf(
  leaf: InlineTextBlock,
  offset: number,
  place: BlockNode[],
  gen: () => string
): { blocks: BlockNode[]; caret: { id: string; offset: number } } {
  const [head, tail] = splitInline(leaf.inline, offset);
  const headEmpty = inlineLength(head) === 0;
  const tailEmpty = inlineLength(tail) === 0;
  const isHeading = leaf.type === 'heading';
  const level = leaf.type === 'heading' ? leaf.level : 1;
  // Clean seam before the first pasted block; later blocks keep their parsed gaps.
  const inserted = place.map((b, i) => (i === 0 ? { ...b, gapBefore: null } : b));

  // Caret-block identity: a heading pasted-into at its START stays a heading, and
  // the pasted blocks land BEFORE it (no "para2Title" demotion, F25/defect 3).
  if (isHeading && headEmpty && !tailEmpty) {
    const kept: BlockNode = { ...leaf, inline: tail, dirty: true };
    return { blocks: [...inserted, kept], caret: { id: kept.id, offset: 0 } };
  }

  const first = inserted[0]!;
  const last = inserted[inserted.length - 1]!;
  const firstPara = !headEmpty && first.type === 'paragraph' ? first : null;
  // A heading never merges its tail into a trailing pasted paragraph — that would
  // demote the tail to prose. Only a paragraph caret block merges its tail.
  const lastPara = !isHeading && !tailEmpty && last !== first && last.type === 'paragraph' ? last : null;

  const out: BlockNode[] = [];
  if (firstPara) {
    out.push({ ...leaf, inline: [...head, ...firstPara.inline], dirty: true });
  } else {
    if (!headEmpty) out.push({ ...leaf, inline: head, dirty: true });
    out.push(first);
  }
  out.push(...inserted.slice(1, lastPara ? -1 : undefined));

  let caret: { id: string; offset: number };
  if (lastPara) {
    const merged: BlockNode = { ...lastPara, inline: [...lastPara.inline, ...tail], dirty: true };
    out.push(merged);
    caret = { id: merged.id, offset: inlineLength(lastPara.inline) };
  } else if (!tailEmpty) {
    const tailBlock = newInline(isHeading ? 'heading' : 'paragraph', tail, level, gen);
    out.push(tailBlock);
    caret = { id: tailBlock.id, offset: 0 };
  } else if (isInlineText(last)) {
    caret = { id: last.id, offset: inlineLength(last.inline) };
  } else {
    // Last pasted block has no caret home (code/table/rule): seed a trailing
    // paragraph so the caret never lands on a barrier.
    const landing = newInline('paragraph', [], 1, gen);
    out.push(landing);
    caret = { id: landing.id, offset: 0 };
  }
  return { blocks: out, caret };
}

// Partition pasted blocks into those a container can hold and those that split out.
function partition(parsed: BlockNode[]): { graftable: BlockNode[]; splitOut: BlockNode[] } {
  const graftable: BlockNode[] = [];
  const splitOut: BlockNode[] = [];
  for (const b of parsed) (splitsOut(b) ? splitOut : graftable).push(b);
  return { graftable, splitOut };
}

// Build the sibling list items a paste produces inside a list. Pasted list content
// grafts as sibling items; every other graftable block becomes its own item (one
// paragraph per item, Notion behaviour). `spread` follows the caret item's rhythm.
function itemsFromGraftable(graftable: BlockNode[], spread: boolean): ListItem[] {
  const items: ListItem[] = [];
  for (const b of graftable) {
    if (isList(b)) items.push(...b.items);
    else items.push({ spread, children: [b] });
  }
  return items;
}

type ContainerGraft = { node: BlockNode; caret: { id: string; offset: number }; splitOut: BlockNode[] };

// Graft `parsed` at `leafId` inside `container` (a list or blockquote), recursing
// to the exact item / child that holds the leaf. Returns the rewritten container,
// the caret, and any blocks that must split out after the top-level container.
function graftContainer(
  container: ContainerBlock,
  leafId: string,
  offset: number,
  parsed: BlockNode[],
  gen: () => string
): ContainerGraft | null {
  if (container.type === 'blockquote') {
    const ci = container.children.findIndex((c) => c.id === leafId);
    if (ci >= 0) {
      const child = container.children[ci]!;
      if (!isInlineText(child)) return null;
      const { graftable, splitOut } = partition(parsed);
      const spliced = spliceParsedAtLeaf(child, offset, graftable, gen);
      const children = [...container.children.slice(0, ci), ...spliced.blocks, ...container.children.slice(ci + 1)];
      const caret = graftable.length > 0 ? (lastInlineLeaf(spliced.blocks) ?? spliced.caret) : spliced.caret;
      return { node: { ...container, children, dirty: true }, caret, splitOut };
    }
    // Deeper: a container nested inside this quote holds the leaf.
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i]!;
      if (isContainer(child) && findLeaf(child, leafId)) {
        const r = graftContainer(child, leafId, offset, parsed, gen);
        if (!r) return null;
        const children = container.children.slice();
        children[i] = r.node;
        return { node: { ...container, children, dirty: true }, caret: r.caret, splitOut: r.splitOut };
      }
    }
    return null;
  }

  // A list: find the item whose direct child (or a deeper container) holds the leaf.
  for (let k = 0; k < container.items.length; k++) {
    const item = container.items[k]!;
    const ci = item.children.findIndex((c) => c.id === leafId);
    if (ci >= 0) {
      const child = item.children[ci]!;
      if (!isInlineText(child)) return null;
      const { graftable, splitOut } = partition(parsed);
      const [head, tail] = splitInline(child.inline, offset);
      const tailEmpty = inlineLength(tail) === 0;
      // The caret item keeps the head; everything after the caret leaf in the item
      // (a nested sublist, say) plus the tail re-homes into a trailing item.
      const before = item.children.slice(0, ci);
      const afterChildren = item.children.slice(ci + 1);
      const caretItem: ListItem = { ...item, children: [...before, { ...child, inline: head, dirty: true }] };
      const grafted = itemsFromGraftable(graftable, item.spread === true);
      const tailChildren: BlockNode[] = [];
      if (!tailEmpty) tailChildren.push({ ...child, id: gen(), inline: tail, dirty: true });
      tailChildren.push(...afterChildren);
      const trailing: ListItem[] = tailChildren.length > 0 ? [{ spread: item.spread === true, children: tailChildren }] : [];
      const items = [
        ...container.items.slice(0, k),
        caretItem,
        ...grafted,
        ...trailing,
        ...container.items.slice(k + 1)
      ];
      const caret =
        lastInlineLeaf(grafted.flatMap((it) => it.children)) ??
        (trailing.length > 0 ? (lastInlineLeaf(trailing[0]!.children) ?? { id: child.id, offset: inlineLength(head) }) : { id: child.id, offset: inlineLength(head) });
      return { node: { ...container, items, dirty: true }, caret, splitOut };
    }
    // Deeper: a container nested inside this item holds the leaf.
    for (let cj = 0; cj < item.children.length; cj++) {
      const child = item.children[cj]!;
      if (isContainer(child) && findLeaf(child, leafId)) {
        const r = graftContainer(child, leafId, offset, parsed, gen);
        if (!r) return null;
        const children = item.children.slice();
        children[cj] = r.node;
        const items = container.items.slice();
        items[k] = { ...item, children };
        return { node: { ...container, items, dirty: true }, caret: r.caret, splitOut: r.splitOut };
      }
    }
  }
  return null;
}

// Does `container` hold `leafId` anywhere in its subtree?
function findLeaf(container: ContainerBlock, leafId: string): boolean {
  const scan = (blocks: BlockNode[]): boolean =>
    blocks.some((b) => {
      if (b.id === leafId) return true;
      if (b.type === 'blockquote') return scan(b.children);
      if (isList(b)) return b.items.some((it) => scan(it.children));
      return false;
    });
  return container.type === 'blockquote' ? scan(container.children) : container.items.some((it) => scan(it.children));
}

/**
 * Paste `parsed` at the collapsed caret (`leafId`, `offset`) when the caret leaf is
 * nested inside a top-level list / blockquote. Grafts graftable blocks into the
 * container and splices any split-out blocks (table / code / rule / frozen)
 * immediately AFTER that top-level container. Returns null when `leafId` is not
 * nested in a container (the caller uses the top-level splice instead).
 */
export function graftIntoContainer(
  blocks: BlockNode[],
  leafId: string,
  offset: number,
  parsed: BlockNode[],
  gen: () => string
): StructuralResult | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (!isContainer(b) || !findLeaf(b, leafId)) continue;
    const r = graftContainer(b, leafId, offset, parsed, gen);
    if (!r) return null;
    const out = blocks.slice();
    out.splice(i, 1, r.node, ...r.splitOut);
    return { blocks: out, caret: r.caret };
  }
  return null;
}
