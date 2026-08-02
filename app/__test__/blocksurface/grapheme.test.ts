// Grapheme arithmetic (grapheme.ts). Pure measurement, no DOM: how many code
// units one Backspace or one Delete should move over. The delete paths are
// exercised end to end in grapheme-delete.test.ts; these pin the numbers.

import { describe, expect, it } from 'vitest';
import { graphemeAfter, graphemeBefore } from '../../src/lib/blocksurface/grapheme';

// Written as escapes rather than literals so the intended code-unit counts are
// visible in the source and cannot be quietly normalized by an editor.
const GRIN = '\u{1F600}'; // 2 units
const THUMB_TONE = '\u{1F44D}\u{1F3FD}'; // 4 units: base + skin-tone modifier
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 8 units, ZWJ-joined
const FLAG = '\u{1F1F3}\u{1F1F4}'; // 4 units, regional indicator pair
const E_ACUTE = 'é'; // 2 units: 'e' + combining acute

describe('graphemeBefore', () => {
  it('is zero at the start of the text', () => {
    expect(graphemeBefore('abc', 0)).toBe(0);
    expect(graphemeBefore('', 0)).toBe(0);
  });

  it('is one for a plain BMP character', () => {
    expect(graphemeBefore('abc', 3)).toBe(1);
  });

  it('takes both halves of a surrogate pair', () => {
    expect(graphemeBefore(GRIN, GRIN.length)).toBe(2);
    expect(graphemeBefore(`a${GRIN}`, 3)).toBe(2);
  });

  it('takes a skin-tone modifier with its base', () => {
    expect(graphemeBefore(THUMB_TONE, THUMB_TONE.length)).toBe(4);
  });

  it('takes a whole ZWJ sequence', () => {
    expect(graphemeBefore(FAMILY, FAMILY.length)).toBe(8);
  });

  it('takes a regional-indicator flag pair', () => {
    expect(graphemeBefore(FLAG, FLAG.length)).toBe(4);
  });

  it('takes a combining mark with its base letter', () => {
    expect(graphemeBefore(E_ACUTE, E_ACUTE.length)).toBe(2);
  });

  it('never steps back further than the caret', () => {
    expect(graphemeBefore(`${GRIN}x`, 1)).toBeLessThanOrEqual(1);
  });
});

describe('graphemeAfter', () => {
  it('is zero at the end of the text', () => {
    expect(graphemeAfter('abc', 3)).toBe(0);
    expect(graphemeAfter('', 0)).toBe(0);
  });

  it('is one for a plain BMP character', () => {
    expect(graphemeAfter('abc', 0)).toBe(1);
  });

  it('takes both halves of a surrogate pair', () => {
    expect(graphemeAfter(GRIN, 0)).toBe(2);
    expect(graphemeAfter(`${GRIN}a`, 0)).toBe(2);
  });

  it('takes a whole ZWJ sequence', () => {
    expect(graphemeAfter(FAMILY, 0)).toBe(8);
  });

  it('takes a skin-tone modifier with its base', () => {
    expect(graphemeAfter(THUMB_TONE, 0)).toBe(4);
  });
});

// The property that actually matters: walking the string by these steps must
// land only on cluster boundaries and consume it exactly, so no sequence of
// deletes can ever leave a broken half behind.
describe('stepping consumes text exactly', () => {
  const samples = [`a${GRIN}b`, `${FAMILY}${GRIN}`, `${THUMB_TONE}x${FLAG}`, `${E_ACUTE}${GRIN}`];

  it('walks backward to exactly zero', () => {
    for (const s of samples) {
      let at = s.length;
      let guard = 0;
      while (at > 0 && guard++ < 100) at -= graphemeBefore(s, at);
      expect(at, s).toBe(0);
    }
  });

  it('walks forward to exactly the end', () => {
    for (const s of samples) {
      let at = 0;
      let guard = 0;
      while (at < s.length && guard++ < 100) at += graphemeAfter(s, at);
      expect(at, s).toBe(s.length);
    }
  });
});
