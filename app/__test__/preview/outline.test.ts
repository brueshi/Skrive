// The rail's active-section logic. Tops are px offsets of headings from
// the top of the scroller content; the helper picks which one the
// reader is currently inside.

import { describe, expect, it } from 'vitest';
import {
  activeHeadingIndex,
  hasChildren,
  nearestVisible,
  sectionEnd,
  visibleIndices
} from '../../src/lib/preview/outline';

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

// A conventional document:
//   0 h1 Title
//   1   h2 Intro
//   2     h3 Background
//   3   h2 Method
//   4 h1 Appendix
const DEPTHS = [1, 2, 3, 2, 1];

describe('sectionEnd', () => {
  it('runs a section to the next heading at or above its depth', () => {
    expect(sectionEnd(DEPTHS, 0)).toBe(4); // Title holds 1..3
    expect(sectionEnd(DEPTHS, 1)).toBe(3); // Intro holds Background
    expect(sectionEnd(DEPTHS, 3)).toBe(4); // Method holds nothing
  });

  it('ends a leaf section immediately after itself', () => {
    expect(sectionEnd(DEPTHS, 2)).toBe(3);
  });

  it('runs the last heading to the end of the list', () => {
    expect(sectionEnd(DEPTHS, 4)).toBe(5);
  });

  it('returns a usable slice end for an out-of-range index', () => {
    expect(sectionEnd(DEPTHS, 9)).toBe(10);
    expect(sectionEnd([], 0)).toBe(1);
  });

  it('tolerates a skipped level', () => {
    // h1 straight to h3, with no h2 in between: the h3 is still a child.
    expect(sectionEnd([1, 3, 1], 0)).toBe(2);
  });

  it('tolerates a document that starts deep and rises above its opening', () => {
    // h3 first, then h1: the h1 is not a descendant of the h3.
    expect(sectionEnd([3, 1, 2], 0)).toBe(1);
    expect(sectionEnd([3, 1, 2], 1)).toBe(3);
  });
});

describe('hasChildren', () => {
  it('is true only for headings with a nested heading under them', () => {
    expect(DEPTHS.map((_, i) => hasChildren(DEPTHS, i))).toEqual([
      true, // Title
      true, // Intro
      false, // Background
      false, // Method
      false // Appendix
    ]);
  });
});

describe('visibleIndices', () => {
  it('shows everything when nothing is folded', () => {
    expect(visibleIndices(DEPTHS, new Set())).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps a folded heading and hides only its section', () => {
    expect(visibleIndices(DEPTHS, new Set([1]))).toEqual([0, 1, 3, 4]);
  });

  it('collapses a whole subtree when an ancestor folds', () => {
    expect(visibleIndices(DEPTHS, new Set([0]))).toEqual([0, 4]);
  });

  it('does not double-count a fold nested inside a folded section', () => {
    // Intro is already swallowed by Title's fold; folding it too changes
    // nothing, and must not skip past Appendix.
    expect(visibleIndices(DEPTHS, new Set([0, 1]))).toEqual([0, 4]);
  });

  it('ignores a fold on a heading with no children', () => {
    expect(visibleIndices(DEPTHS, new Set([2]))).toEqual([0, 1, 2, 3, 4]);
  });

  it('returns nothing for an empty document', () => {
    expect(visibleIndices([], new Set())).toEqual([]);
  });
});

describe('nearestVisible', () => {
  it('returns the heading itself when it is visible', () => {
    const visible = new Set(visibleIndices(DEPTHS, new Set([1])));
    expect(nearestVisible(3, visible)).toBe(3);
  });

  it('falls back to the fold that swallowed the heading', () => {
    // Background (2) is hidden inside folded Intro (1).
    const visible = new Set(visibleIndices(DEPTHS, new Set([1])));
    expect(nearestVisible(2, visible)).toBe(1);
  });

  it('climbs to the outermost fold through nested collapses', () => {
    // Title folded swallows Intro and Background alike.
    const visible = new Set(visibleIndices(DEPTHS, new Set([0])));
    expect(nearestVisible(2, visible)).toBe(0);
  });

  it('returns -1 when there is nothing at or before the index', () => {
    expect(nearestVisible(-1, new Set([0]))).toBe(-1);
    expect(nearestVisible(3, new Set())).toBe(-1);
  });
});
