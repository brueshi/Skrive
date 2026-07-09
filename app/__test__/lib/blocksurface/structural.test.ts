// Nested structural edits (SKR-95, Stage 3f). Enter inside a container and
// exit-on-empty, as pure tree transforms.

import { describe, it, expect } from 'vitest';
import { enterInContainer, exitContainer } from '../../../src/lib/blocksurface/structural';
import type { BlockNode } from '../../../src/lib/blockmodel';

function para(id: string, text: string): BlockNode {
  return { type: 'paragraph', id, durable: false, src: null, gapBefore: null, dirty: false, inline: text ? [{ kind: 'text', text, marks: {} }] : [] };
}
function quote(id: string, children: BlockNode[]): BlockNode {
  return { type: 'blockquote', id, durable: false, src: 'x', gapBefore: null, dirty: false, children };
}
function list(id: string, items: BlockNode[][]): BlockNode {
  return {
    type: 'bullet_list',
    id,
    durable: false,
    src: 'y',
    gapBefore: null,
    dirty: false,
    marker: '-',
    spread: false,
    items: items.map((children) => ({ spread: false, children }))
  };
}
function counter(): () => string {
  let n = 0;
  return () => `new${n++}`;
}

describe('enterInContainer', () => {
  it('splits a quote child into two paragraphs', () => {
    const r = enterInContainer([quote('q', [para('qp', 'hello')])], 'qp', 2, 2, counter());
    expect(r).not.toBeNull();
    const q = r!.blocks[0]!;
    expect(q.type === 'blockquote' && q.children.length).toBe(2);
    expect(q.type === 'blockquote' && q.dirty).toBe(true);
    expect(r!.caret).toEqual({ id: 'new0', offset: 0 });
  });

  it('splits a list item into two items', () => {
    const r = enterInContainer([list('l', [[para('lp', 'hi')]])], 'lp', 1, 1, counter());
    const l = r!.blocks[0]!;
    expect(l.type === 'bullet_list' && l.items.length).toBe(2);
    expect(r!.caret.id).toBe('new0');
  });

  it('returns null for a top-level block (the caller handles it)', () => {
    expect(enterInContainer([para('top', 'x')], 'top', 1, 1, counter())).toBeNull();
  });

  it('splits a NESTED list item (depth 2), not just the top level', () => {
    // outer list > item[ para 'a', inner list > item[ para 'b' ] ]
    const inner = list('inner', [[para('b', 'bbb')]]);
    const outer = list('outer', [[para('a', 'a'), inner]]);
    const r = enterInContainer([outer], 'b', 1, 1, counter());
    expect(r, 'nested item Enter is handled (was a silent no-op)').not.toBeNull();
    const o = r!.blocks[0]!;
    // The inner list now has two items; the caret is in the freshly minted one.
    const innerAfter = o.type === 'bullet_list' ? o.items[0]!.children[1]! : null;
    expect(innerAfter && innerAfter.type === 'bullet_list' && innerAfter.items.length).toBe(2);
    expect(r!.caret.id).toBe('new0');
  });
});

describe('exitContainer', () => {
  it('replaces an emptied quote with a paragraph', () => {
    const r = exitContainer([quote('q', [para('qp', '')])], 'qp', counter());
    expect(r!.blocks).toHaveLength(1);
    expect(r!.blocks[0]!.type).toBe('paragraph');
    expect(r!.caret.id).toBe(r!.blocks[0]!.id);
  });

  it('drops a paragraph after a list that still has items', () => {
    const r = exitContainer([list('l', [[para('a', 'one')], [para('b', '')]])], 'b', counter());
    expect(r!.blocks).toHaveLength(2);
    expect(r!.blocks[0]!.type).toBe('bullet_list');
    expect(r!.blocks[1]!.type).toBe('paragraph');
  });

  it('exits an empty NESTED quote line at its own level', () => {
    // quote > [ para 'a', quote > [ para '' ] ]
    const innerQ = quote('iq', [para('p', '')]);
    const r = exitContainer([quote('oq', [para('a', 'a'), innerQ])], 'p', counter());
    expect(r, 'nested exit is handled').not.toBeNull();
    // The inner quote emptied, so it is replaced by the paragraph inside the outer.
    const oq = r!.blocks[0]!;
    expect(oq.type === 'blockquote' && oq.children[1]!.type).toBe('paragraph');
  });
});
