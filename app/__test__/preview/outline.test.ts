// The rail's active-section logic. Tops are px offsets of headings from
// the top of the scroller content; the helper picks which one the
// reader is currently inside.

import { describe, expect, it } from 'vitest';
import { activeHeadingIndex } from '../../src/lib/preview/outline';

// A 2000px document in an 800px viewport, headings at 0 / 600 / 1400.
const TOPS = [0, 600, 1400];
const CLIENT = 800;
const SCROLL_HEIGHT = 2000;

describe('activeHeadingIndex', () => {
  it('returns -1 for an empty document', () => {
    expect(activeHeadingIndex([], 0, CLIENT, SCROLL_HEIGHT)).toBe(-1);
  });

  it('keeps the first heading active at the top', () => {
    expect(activeHeadingIndex(TOPS, 0, CLIENT, SCROLL_HEIGHT)).toBe(0);
  });

  it('advances as each heading crosses the activation line', () => {
    expect(activeHeadingIndex(TOPS, 600, CLIENT, SCROLL_HEIGHT)).toBe(1);
    expect(activeHeadingIndex(TOPS, 1380, CLIENT, SCROLL_HEIGHT)).toBe(2);
  });

  it('does not advance until the heading is at or past the line', () => {
    // 560 + 24 activation = 584 < 600, so heading 1 is not active yet.
    expect(activeHeadingIndex(TOPS, 560, CLIENT, SCROLL_HEIGHT)).toBe(0);
  });

  it('snaps to the last heading at the very bottom of a scroll', () => {
    // maxScroll = 1200; heading 2 (top 1400) never reaches the line, but
    // it is the section being read at the bottom.
    expect(activeHeadingIndex(TOPS, 1200, CLIENT, SCROLL_HEIGHT)).toBe(2);
  });

  it('ignores the bottom-snap when the document does not overflow', () => {
    // clientHeight >= scrollHeight: nothing scrolls, so the activation
    // line alone applies and the first heading stays active.
    expect(activeHeadingIndex(TOPS, 0, 2000, 2000)).toBe(0);
  });

  it('keeps the clicked heading active despite a scroll undershoot', () => {
    // Clicking heading 1 (top 600) scrolls to 600 - 16px margin = 584,
    // but scrollTop can round down a hair to 583. A 40px activation
    // offset leaves enough slack that the heading still selects rather
    // than flipping to the one above — the rail's click off-by-one.
    expect(activeHeadingIndex(TOPS, 583, CLIENT, SCROLL_HEIGHT, 40)).toBe(1);
    // With no slack (offset == the 16px scroll margin) the same
    // undershoot would wrongly select heading 0.
    expect(activeHeadingIndex(TOPS, 583, CLIENT, SCROLL_HEIGHT, 16)).toBe(0);
  });
});
