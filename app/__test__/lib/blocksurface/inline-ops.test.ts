// Pure inline-model edits (SKR-95, Stage 3a). The browser tests cover the DOM
// paths (selection, IME, fidelity); these pin the offset/mark logic the hot path
// runs on every keystroke, independent of a DOM.

import { describe, it, expect } from 'vitest';
import {
  clearMarksInInline,
  coalesceInline,
  deleteRangeInInline,
  footnoteRefAt,
  inlineLength,
  inlineScanText,
  SCAN_ATOM,
  inlinePlainText,
  insertTextInInline,
  marksEqual,
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

  it('drops a fully-removed run and merges the same-mark survivors (SKR-192)', () => {
    expect(deleteRangeInInline([text('a'), text('bb', { strong: true }), text('c')], 1, 3)).toEqual([text('ac')]);
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
    // Backspace at the caret just after the break deletes [2,3) — the break's
    // cell — and the same-mark neighbors merge (SKR-192).
    expect(deleteRangeInInline([text('ab'), brk(), text('cd')], 2, 3)).toEqual([text('abcd')]);
  });

  it('deleteRangeInInline keeps an atom whose cell is outside the range', () => {
    expect(deleteRangeInInline([text('ab'), img(), text('cd')], 0, 1)).toEqual([text('b'), img(), text('cd')]);
  });

  it('deleteRangeInInline removes only the atoms inside a spanning range (F05)', () => {
    // a i0 b i1 c  ->  offsets a[0] i0[1] b[2] i1[3] c[4]; delete [1,4) drops both
    // atoms + b, and the unmarked survivors merge (SKR-192).
    const nodes = [text('a'), img('0'), text('b'), img('1'), text('c')];
    expect(deleteRangeInInline(nodes, 1, 4)).toEqual([text('ac')]);
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

  it('adds when only part of the range has the mark, coalescing the result', () => {
    const nodes = [text('ab', { em: true }), text('cd')];
    expect(toggleMarkInInline(nodes, 0, 4, 'em')).toEqual([text('abcd', { em: true })]);
  });

  it('toggles strikethrough over a sub-range and clears it on a second toggle', () => {
    const struck = toggleMarkInInline([text('done later')], 0, 4, 'strikethrough');
    expect(struck).toEqual([text('done', { strikethrough: true }), text(' later')]);
    expect(toggleMarkInInline(struck, 0, 4, 'strikethrough')).toEqual([text('done later')]);
  });

  it('toggles underline over a sub-range and clears it on a second toggle', () => {
    const lined = toggleMarkInInline([text('read this')], 0, 4, 'underline');
    expect(lined).toEqual([text('read', { underline: true }), text(' this')]);
    expect(toggleMarkInInline(lined, 0, 4, 'underline')).toEqual([text('read this')]);
  });
});

describe('clearMarksInInline', () => {
  it('strips every character mark over the range but keeps links', () => {
    const link = { href: 'u', title: null };
    const nodes = [text('bold', { strong: true, em: true }), text('link', { link }), text('u', { underline: true })];
    expect(clearMarksInInline(nodes, 0, 9)).toEqual([text('bold'), text('link', { link }), text('u')]);
  });

  it('clears only the covered sub-range, splitting the run', () => {
    expect(clearMarksInInline([text('abcd', { strong: true })], 1, 3)).toEqual([
      text('a', { strong: true }),
      text('bc'),
      text('d', { strong: true })
    ]);
  });

  it('is a no-op on an empty range', () => {
    const nodes = [text('hi', { strong: true })];
    expect(clearMarksInInline(nodes, 2, 2)).toBe(nodes);
  });
});

describe('setMarkInInline', () => {
  it('forces the mark on regardless of current state, coalescing the result', () => {
    expect(setMarkInInline([text('ab', { strong: true }), text('cd')], 0, 4, 'strong', true)).toEqual([
      text('abcd', { strong: true })
    ]);
  });

  it('forces the mark off regardless of current state, coalescing the result', () => {
    expect(setMarkInInline([text('ab', { strong: true }), text('cd')], 0, 4, 'strong', false)).toEqual([text('abcd')]);
  });

  it('does not invert a half-marked range the way a per-block toggle would', () => {
    // The whole point: a multi-block selection decides on/off once, then forces
    // every block to match — so a partly-bold selection ends up fully bold.
    expect(setMarkInInline([text('abcd', { strong: true })], 0, 4, 'strong', true)).toEqual([
      text('abcd', { strong: true })
    ]);
  });
});

// SKR-192: adjacent same-mark runs merge so repeated toggling never accumulates
// sibling <strong>/<em> elements and word selection never stops at a run seam.
describe('coalesceInline', () => {
  it('merges adjacent same-mark runs, including chains', () => {
    expect(coalesceInline([text('a'), text('b'), text('c')])).toEqual([text('abc')]);
    expect(coalesceInline([text('a', { strong: true }), text('b', { strong: true })])).toEqual([
      text('ab', { strong: true })
    ]);
  });

  it('keeps runs with different marks apart', () => {
    const nodes = [text('a'), text('b', { em: true }), text('c')];
    expect(coalesceInline(nodes)).toBe(nodes);
  });

  it('treats absent and false boolean marks as the same state', () => {
    expect(coalesceInline([text('a', { strong: false }), text('b')])).toEqual([text('ab', { strong: false })]);
  });

  it('never merges across an atom', () => {
    const nodes = [text('a'), brk(), text('b')];
    expect(coalesceInline(nodes)).toBe(nodes);
    const withImg = [text('a'), img(), text('b')];
    expect(coalesceInline(withImg)).toBe(withImg);
  });

  it('compares links by href AND title', () => {
    const l = (href: string, title: string | null): InlineNode['marks'] => ({ link: { href, title } });
    expect(coalesceInline([text('a', l('u', null)), text('b', l('u', null))])).toEqual([text('ab', l('u', null))]);
    expect(coalesceInline([text('a', l('u', null)), text('b', l('v', null))])).toHaveLength(2);
    expect(coalesceInline([text('a', l('u', 't')), text('b', l('u', null))])).toHaveLength(2);
  });

  it('returns the same reference when nothing merges', () => {
    const nodes = [text('a', { em: true }), text('b')];
    expect(coalesceInline(nodes)).toBe(nodes);
    const single = [text('a')];
    expect(coalesceInline(single)).toBe(single);
  });
});

describe('marksEqual', () => {
  it('compares each boolean mark by truthiness', () => {
    expect(marksEqual({}, { strong: false })).toBe(true);
    expect(marksEqual({ em: true }, { em: true, code: false })).toBe(true);
    expect(marksEqual({ em: true }, { strong: true })).toBe(false);
    expect(marksEqual({ code: true }, {})).toBe(false);
    expect(marksEqual({ strikethrough: true }, { strikethrough: true })).toBe(true);
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

describe('footnoteRefAt (SKR-56)', () => {
  const fnref = (label: string): InlineNode => ({ kind: 'footnote_ref', label, marks: {} });

  it('returns the label when the cell at the offset is a footnote reference', () => {
    expect(footnoteRefAt([text('ab'), fnref('1'), text('cd')], 2)).toBe('1');
  });

  it('returns null on text cells and other atoms', () => {
    const nodes = [text('ab'), fnref('1'), img(), text('cd')];
    expect(footnoteRefAt(nodes, 0)).toBeNull(); // 'a'
    expect(footnoteRefAt(nodes, 1)).toBeNull(); // 'b'
    expect(footnoteRefAt(nodes, 3)).toBeNull(); // the image atom
    expect(footnoteRefAt(nodes, 4)).toBeNull(); // 'c'
  });

  it('returns null out of range (negative and past-end offsets)', () => {
    const nodes = [fnref('1')];
    expect(footnoteRefAt(nodes, -1)).toBeNull();
    expect(footnoteRefAt(nodes, 1)).toBeNull();
  });

  it('distinguishes adjacent references by offset', () => {
    const nodes = [fnref('1'), fnref('2')];
    expect(footnoteRefAt(nodes, 0)).toBe('1');
    expect(footnoteRefAt(nodes, 1)).toBe('2');
  });
});

describe('inlineScanText (SKR-56)', () => {
  const fnref = (label: string): InlineNode => ({ kind: 'footnote_ref', label, marks: {} });
  const tag = (name: string): InlineNode => ({ kind: 'tag', name, marks: {} });

  it('aligns string indices with flat offsets', () => {
    const nodes = [text('ab'), img(), text('cd'), tag('x'), brk(), fnref('1')];
    const s = inlineScanText(nodes);
    expect(s).toBe(`ab${SCAN_ATOM}cd#x${SCAN_ATOM}${SCAN_ATOM}`);
    expect(s.length).toBe(inlineLength(nodes));
  });

  it('is plain text when there are no atoms', () => {
    expect(inlineScanText([text('hello '), text('world', { strong: true })])).toBe('hello world');
  });
});
