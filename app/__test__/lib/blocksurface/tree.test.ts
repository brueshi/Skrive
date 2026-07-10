// Block-tree addressing (SKR-95, Stage 3e). Finding and updating a block nested
// inside a container, and the invariant that an edit to a nested block marks its
// ancestor containers dirty so they re-serialize around the change.

import { describe, it, expect } from 'vitest';
import { blockIndexOf, findBlockById, updateBlockById, updateBlockInTop } from '../../../src/lib/blocksurface/tree';
import type { BlockNode } from '../../../src/lib/blockmodel';

function para(id: string, text: string): BlockNode {
  return { type: 'paragraph', id, durable: false, src: null, gapBefore: null, dirty: false, inline: [{ kind: 'text', text, marks: {} }] };
}

function fixture(): BlockNode[] {
  const quote: BlockNode = { type: 'blockquote', id: 'q', durable: false, src: 'x', gapBefore: null, dirty: false, children: [para('qp', 'hi')] };
  const list: BlockNode = {
    type: 'bullet_list',
    id: 'l',
    durable: false,
    src: 'y',
    gapBefore: null,
    dirty: false,
    marker: '-',
    spread: false,
    items: [{ spread: false, children: [para('lp', 'yo')] }]
  };
  return [para('top', 'top'), quote, list];
}

describe('findBlockById', () => {
  it('finds top-level and nested blocks', () => {
    const blocks = fixture();
    expect(findBlockById(blocks, 'top')?.id).toBe('top');
    expect(findBlockById(blocks, 'qp')?.id).toBe('qp'); // inside a blockquote
    expect(findBlockById(blocks, 'lp')?.id).toBe('lp'); // inside a list item
    expect(findBlockById(blocks, 'nope')).toBeNull();
  });
});

describe('updateBlockById', () => {
  it('updates a nested block and marks its container dirty', () => {
    const blocks = fixture();
    const next = updateBlockById(blocks, 'qp', (b) =>
      b.type === 'paragraph' ? { ...b, inline: [{ kind: 'text', text: 'EDITED', marks: {} }], dirty: true } : b
    );
    const quote = next.find((b) => b.id === 'q')!;
    if (quote.type === 'frozen_block') throw new Error('unexpected frozen block');
    expect(quote.dirty, 'container dirtied').toBe(true);
    const child = quote.type === 'blockquote' ? quote.children[0]! : null;
    expect(child && child.type === 'paragraph' && child.inline[0]?.kind === 'text' && child.inline[0].text).toBe('EDITED');
  });

  it('updates a block inside a list item and dirties the list', () => {
    const next = updateBlockById(fixture(), 'lp', (b) => ({ ...b, dirty: true }));
    const list = next.find((b) => b.id === 'l')!;
    if (list.type === 'frozen_block') throw new Error('unexpected frozen block');
    expect(list.dirty).toBe(true);
  });

  it('leaves untouched branches by reference', () => {
    const blocks = fixture();
    const next = updateBlockById(blocks, 'qp', (b) => ({ ...b, dirty: true }));
    expect(next.find((b) => b.id === 'top')).toBe(blocks.find((b) => b.id === 'top'));
    expect(next.find((b) => b.id === 'l')).toBe(blocks.find((b) => b.id === 'l'));
  });

  it('returns the SAME array when the id is not in the tree', () => {
    const blocks = fixture();
    expect(updateBlockById(blocks, 'nope', (b) => ({ ...b, dirty: true }))).toBe(blocks);
  });

  it('keeps lookups correct on both the old and the new array after an edit', () => {
    const blocks = fixture();
    const next = updateBlockById(blocks, 'lp', (b) => ({ ...b, dirty: true }));
    // The new array resolves every id (including nested ones under an
    // unchanged top-level block)...
    expect(findBlockById(next, 'top')?.id).toBe('top');
    expect(findBlockById(next, 'qp')?.id).toBe('qp');
    const editedLeaf = findBlockById(next, 'lp');
    expect(editedLeaf?.type === 'paragraph' && editedLeaf.dirty).toBe(true);
    // ...and the OLD array (held by undo history) still resolves against its
    // own pre-edit objects.
    const oldLeaf = findBlockById(blocks, 'lp');
    expect(oldLeaf?.type === 'paragraph' && oldLeaf.dirty).toBe(false);
  });

  it('resolves a replacement id after an edit that re-keys the block', () => {
    const blocks = fixture();
    const next = updateBlockById(blocks, 'qp', (b) => ({ ...b, id: 'qp2', dirty: true }));
    expect(findBlockById(next, 'qp2')?.id).toBe('qp2');
    expect(findBlockById(next, 'qp')).toBeNull();
  });
});

describe('blockIndexOf', () => {
  it('maps every id (top-level and nested) to its top-level index', () => {
    const blocks = fixture();
    const index = blockIndexOf(blocks);
    expect(index.get('top')).toBe(0);
    expect(index.get('q')).toBe(1);
    expect(index.get('qp')).toBe(1);
    expect(index.get('l')).toBe(2);
    expect(index.get('lp')).toBe(2);
    expect(index.get('nope')).toBeUndefined();
  });

  it('is memoized per array identity', () => {
    const blocks = fixture();
    expect(blockIndexOf(blocks)).toBe(blockIndexOf(blocks));
    expect(blockIndexOf(fixture())).not.toBe(blockIndexOf(blocks));
  });

  it('keeps find-first semantics on a duplicate id', () => {
    const dup = [para('same', 'first'), para('same', 'second')];
    const first = findBlockById(dup, 'same');
    expect(first && first.type === 'paragraph' && first.inline[0]?.kind === 'text' && first.inline[0].text).toBe(
      'first'
    );
  });
});

describe('updateBlockInTop', () => {
  it('rewrites a nested leaf within one top-level block, dirtying the container', () => {
    const blocks = fixture();
    const quote = blocks[1]!;
    const updated = updateBlockInTop(quote, 'qp', (b) => ({ ...b, dirty: true }));
    expect(updated).not.toBe(quote);
    if (updated.type !== 'blockquote') throw new Error('expected a blockquote');
    expect(updated.dirty).toBe(true);
    const child = updated.children[0];
    expect(child?.type === 'paragraph' && child.dirty).toBe(true);
  });

  it('returns the same object when the id is not in the subtree', () => {
    const blocks = fixture();
    const quote = blocks[1]!;
    expect(updateBlockInTop(quote, 'lp', (b) => ({ ...b, dirty: true }))).toBe(quote);
  });
});
