// Block-tree addressing (SKR-95, Stage 3e). Finding and updating a block nested
// inside a container, and the invariant that an edit to a nested block marks its
// ancestor containers dirty so they re-serialize around the change.

import { describe, it, expect } from 'vitest';
import { findBlockById, updateBlockById } from '../../../src/lib/blocksurface/tree';
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
});
