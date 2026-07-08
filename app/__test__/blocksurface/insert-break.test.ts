// insertBreakInInline (SKR-176 / F83). The model primitive behind the Shift+Enter
// gesture: place a hard-break atom at a flat offset, splitting the text run it
// lands in and inheriting that run's marks, so a break typed inside bold stays
// bold and reads back consistently from the DOM.

import { describe, it, expect } from 'vitest';
import { insertBreakInInline } from '../../src/lib/blocksurface/inline-ops';
import type { InlineNode } from '../../src/lib/blockmodel';

const text = (s: string, marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'text', text: s, marks });
const kinds = (nodes: InlineNode[]): string[] => nodes.map((n) => n.kind);

describe('insertBreakInInline', () => {
  it('splits the text run around the break at a mid-run offset', () => {
    const out = insertBreakInInline([text('abcdef')], 3);
    expect(kinds(out)).toEqual(['text', 'break', 'text']);
    expect(out[0]).toMatchObject({ kind: 'text', text: 'abc' });
    expect(out[2]).toMatchObject({ kind: 'text', text: 'def' });
  });

  it('inserts a break at the end without an empty trailing text run', () => {
    const out = insertBreakInInline([text('abc')], 3);
    expect(kinds(out)).toEqual(['text', 'break']);
    expect(out[0]).toMatchObject({ kind: 'text', text: 'abc' });
  });

  it('inserts a break at the start without an empty leading text run', () => {
    const out = insertBreakInInline([text('abc')], 0);
    expect(kinds(out)).toEqual(['break', 'text']);
    expect(out[1]).toMatchObject({ kind: 'text', text: 'abc' });
  });

  it('inherits the marks of the run the caret sits in', () => {
    const out = insertBreakInInline([text('abcdef', { strong: true })], 3);
    expect(out[1]).toMatchObject({ kind: 'break', marks: { strong: true } });
  });

  it('into an empty run yields a lone break with no marks', () => {
    const out = insertBreakInInline([], 0);
    expect(kinds(out)).toEqual(['break']);
    expect(out[0]!.marks).toEqual({});
  });

  it('a seam offset between text and an atom lands the break after the text', () => {
    // "abc" | <img> : offset 3 is the text|atom seam, consumed by the text run.
    const img: InlineNode = { kind: 'image', url: 'x', alt: '', title: null, marks: {} };
    const out = insertBreakInInline([text('abc'), img], 3);
    expect(kinds(out)).toEqual(['text', 'break', 'image']);
  });

  it('past the end inherits the last text run marks', () => {
    const out = insertBreakInInline([text('ab', { em: true })], 99);
    expect(kinds(out)).toEqual(['text', 'break']);
    expect(out[1]).toMatchObject({ kind: 'break', marks: { em: true } });
  });
});
