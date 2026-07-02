// Pure inline-model edits (SKR-95, Stage 3a). The browser tests cover the DOM
// paths (selection, IME, fidelity); these pin the offset/mark logic the hot path
// runs on every keystroke, independent of a DOM.

import { describe, it, expect } from 'vitest';
import {
  deleteRangeInInline,
  inlineLength,
  inlinePlainText,
  insertTextInInline,
  rangeHasLink,
  rangeHasMark,
  setLinkInInline,
  setMarkInInline,
  splitInline,
  toggleMarkInInline
} from '../../../src/lib/blocksurface/inline-ops';
import type { InlineNode } from '../../../src/lib/blockmodel';

const text = (t: string, marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'text', text: t, marks });
const img = (url = 'u', marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'image', url, alt: '', title: null, marks });
const brk = (marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'break', marks });

describe('insertTextInInline', () => {
  it('inserts into a plain run', () => {
    expect(insertTextInInline([text('hello')], 2, 'XX')).toEqual([text('heXXllo')]);
  });

  it('inherits the marks of the run the caret sits in', () => {
    const out = insertTextInInline([text('bold', { strong: true })], 2, 'XX');
    expect(out).toEqual([text('boXXld', { strong: true })]);
  });

  it('appends past the end with the last run’s marks', () => {
    const out = insertTextInInline([text('a', { em: true })], 5, 'Z');
    expect(out).toEqual([text('a', { em: true }), text('Z', { em: true })]);
  });

  it('lands as plain text in an empty block', () => {
    expect(insertTextInInline([], 0, 'hi')).toEqual([text('hi')]);
  });

  it('inserts at a run boundary into the left run', () => {
    const out = insertTextInInline([text('ab'), text('cd', { strong: true })], 2, 'X');
    expect(out).toEqual([text('abX'), text('cd', { strong: true })]);
  });

  it('is a no-op for empty text', () => {
    const nodes = [text('x')];
    expect(insertTextInInline(nodes, 0, '')).toBe(nodes);
  });
});

describe('deleteRangeInInline', () => {
  it('removes characters mid-run', () => {
    expect(deleteRangeInInline([text('hello')], 1, 3)).toEqual([text('hlo')]);
  });

  it('keeps surrounding marks when trimming a run', () => {
    expect(deleteRangeInInline([text('bold', { strong: true })], 0, 2)).toEqual([text('ld', { strong: true })]);
  });

  it('spans runs, preserving each run’s own marks', () => {
    const out = deleteRangeInInline([text('ab'), text('cd', { em: true })], 1, 3);
    expect(out).toEqual([text('a'), text('d', { em: true })]);
  });

  it('drops a fully-removed run', () => {
    expect(deleteRangeInInline([text('a'), text('bb', { strong: true }), text('c')], 1, 3)).toEqual([
      text('a'),
      text('c')
    ]);
  });

  it('is a no-op when start >= end', () => {
    const nodes = [text('x')];
    expect(deleteRangeInInline(nodes, 2, 2)).toBe(nodes);
  });
});

describe('inlineLength', () => {
  it('sums text run lengths', () => {
    expect(inlineLength([text('ab'), text('cde', { strong: true })])).toBe(5);
    expect(inlineLength([])).toBe(0);
  });
});

describe('inlinePlainText', () => {
  it('concatenates text across runs and marks', () => {
    expect(inlinePlainText([text('/'), text('head', { strong: true })])).toBe('/head');
    expect(inlinePlainText([])).toBe('');
  });
});

describe('splitInline', () => {
  it('splits a run at the offset', () => {
    expect(splitInline([text('hello')], 2)).toEqual([[text('he')], [text('llo')]]);
  });

  it('preserves marks on both halves across a run boundary', () => {
    const out = splitInline([text('ab'), text('cd', { em: true })], 3);
    expect(out).toEqual([[text('ab'), text('c', { em: true })], [text('d', { em: true })]]);
  });

  it('splits at the start (empty left) and end (empty right)', () => {
    expect(splitInline([text('hi')], 0)).toEqual([[], [text('hi')]]);
    expect(splitInline([text('hi')], 2)).toEqual([[text('hi')], []]);
  });
});

// SKR-155: atoms (image / hard break) occupy exactly one unit of offset space.
describe('atoms in the offset space', () => {
  it('inlineLength counts each atom as one unit', () => {
    expect(inlineLength([text('ab'), img(), text('cd')])).toBe(5);
    expect(inlineLength([img(), brk()])).toBe(2);
  });

  it('deleteRangeInInline removes an atom when the range covers its cell (F06)', () => {
    // Backspace at the caret just after the break deletes [2,3) — the break's cell.
    expect(deleteRangeInInline([text('ab'), brk(), text('cd')], 2, 3)).toEqual([text('ab'), text('cd')]);
  });

  it('deleteRangeInInline keeps an atom whose cell is outside the range', () => {
    expect(deleteRangeInInline([text('ab'), img(), text('cd')], 0, 1)).toEqual([text('b'), img(), text('cd')]);
  });

  it('deleteRangeInInline removes only the atoms inside a spanning range (F05)', () => {
    // a i0 b i1 c  ->  offsets a[0] i0[1] b[2] i1[3] c[4]; delete [1,4) drops both atoms + b.
    const nodes = [text('a'), img('0'), text('b'), img('1'), text('c')];
    expect(deleteRangeInInline(nodes, 1, 4)).toEqual([text('a'), text('c')]);
  });

  it('splitInline sends an atom to exactly one side, never both (F04)', () => {
    const nodes = [text('ab'), img(), text('cd')];
    // Split after the image (offset 3): image stays on the left.
    expect(splitInline(nodes, 3)).toEqual([[text('ab'), img()], [text('cd')]]);
    // Split before the image (offset 2): image goes to the right.
    expect(splitInline(nodes, 2)).toEqual([[text('ab')], [img(), text('cd')]]);
  });

  it('insertTextInInline lands text on the correct side of an atom', () => {
    expect(insertTextInInline([img()], 0, 'X')).toEqual([text('X'), img()]);
    expect(insertTextInInline([img()], 1, 'X')).toEqual([img(), text('X')]);
    // The text|atom seam is consumed by the preceding run (append), not a new run.
    expect(insertTextInInline([text('ab'), img()], 2, 'X')).toEqual([text('abX'), img()]);
    // Between two atoms.
    expect(insertTextInInline([img('0'), img('1')], 1, 'X')).toEqual([img('0'), text('X'), img('1')]);
  });

  it('mark walkers stay aligned across an atom', () => {
    // b is bold and sits at offset 2 (after "a" and the image cell at [1,2)).
    const nodes = [text('a'), img(), text('b', { strong: true })];
    expect(rangeHasMark(nodes, 2, 3, 'strong')).toBe(true);
    expect(rangeHasMark(nodes, 0, 1, 'strong')).toBe(false);
  });
});

describe('toggleMarkInInline', () => {
  it('adds a mark over a sub-range, splitting the run', () => {
    expect(toggleMarkInInline([text('hello world')], 0, 5, 'strong')).toEqual([
      text('hello', { strong: true }),
      text(' world')
    ]);
  });

  it('removes the mark when the whole range already has it', () => {
    expect(toggleMarkInInline([text('hi', { strong: true })], 0, 2, 'strong')).toEqual([text('hi')]);
  });

  it('adds when only part of the range has the mark', () => {
    const nodes = [text('ab', { em: true }), text('cd')];
    expect(toggleMarkInInline(nodes, 0, 4, 'em')).toEqual([text('ab', { em: true }), text('cd', { em: true })]);
  });
});

describe('setMarkInInline', () => {
  it('forces the mark on regardless of current state', () => {
    expect(setMarkInInline([text('ab', { strong: true }), text('cd')], 0, 4, 'strong', true)).toEqual([
      text('ab', { strong: true }),
      text('cd', { strong: true })
    ]);
  });

  it('forces the mark off regardless of current state', () => {
    expect(setMarkInInline([text('ab', { strong: true }), text('cd')], 0, 4, 'strong', false)).toEqual([
      text('ab'),
      text('cd')
    ]);
  });

  it('does not invert a half-marked range the way a per-block toggle would', () => {
    // The whole point: a multi-block selection decides on/off once, then forces
    // every block to match — so a partly-bold selection ends up fully bold.
    expect(setMarkInInline([text('abcd', { strong: true })], 0, 4, 'strong', true)).toEqual([
      text('abcd', { strong: true })
    ]);
  });
});

describe('rangeHasMark / rangeHasLink', () => {
  it('reports a fully-marked range', () => {
    expect(rangeHasMark([text('hi', { strong: true })], 0, 2, 'strong')).toBe(true);
    expect(rangeHasMark([text('hi', { strong: true }), text('!')], 0, 3, 'strong')).toBe(false);
    expect(rangeHasMark([], 0, 0, 'strong')).toBe(false);
  });

  it('reports a fully-linked range', () => {
    const link = { href: 'https://x', title: null };
    expect(rangeHasLink([text('hi', { link })], 0, 2)).toBe(true);
    expect(rangeHasLink([text('hi')], 0, 2)).toBe(false);
  });
});

describe('setLinkInInline', () => {
  it('sets and clears the link over a range', () => {
    const link = { href: 'https://x', title: null };
    const linked = setLinkInInline([text('hello')], 0, 5, link);
    expect(linked).toEqual([text('hello', { link })]);
    expect(setLinkInInline(linked, 0, 5, null)).toEqual([text('hello')]);
  });
});
