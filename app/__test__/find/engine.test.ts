// The in-document find engine's pure matching core: the string primitive
// (findRanges) and the block-document walk (findInDocument). No DOM — the engine
// is deliberately string/model-only so both editor backends can share it.

import { describe, it, expect } from 'vitest';
import {
  findRanges,
  findInDocument,
  buildMatcher,
  replaceRangesInString,
  type FindFlags
} from '../../src/lib/find/engine';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';
import { inlineScanText } from '../../src/lib/blocksurface/inline-ops';

const flags = (over: Partial<FindFlags> = {}): FindFlags => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...over
});

describe('findRanges', () => {
  it('finds every occurrence in order', () => {
    expect(findRanges('the other theory', 'the', flags())).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 8 },
      { start: 10, end: 13 }
    ]);
  });

  it('is case-insensitive by default and case-sensitive when asked', () => {
    expect(findRanges('The the THE', 'the', flags())).toHaveLength(3);
    expect(findRanges('The the THE', 'the', flags({ caseSensitive: true }))).toEqual([{ start: 4, end: 7 }]);
  });

  it('whole-word matches only bounded occurrences', () => {
    // 'the' at 0 (bounded), inside 'other' (5), inside 'theory' (10).
    expect(findRanges('the other theory', 'the', flags({ wholeWord: true }))).toEqual([{ start: 0, end: 3 }]);
  });

  it('treats the query literally unless regex is on', () => {
    expect(findRanges('a.b axb', 'a.b', flags())).toEqual([{ start: 0, end: 3 }]);
    expect(findRanges('a.b axb', 'a.b', flags({ regex: true }))).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 }
    ]);
  });

  it('returns nothing for an empty query or an invalid regex', () => {
    expect(findRanges('anything', '', flags())).toEqual([]);
    expect(findRanges('anything', '(', flags({ regex: true }))).toEqual([]);
    expect(buildMatcher('(', flags({ regex: true }))).toBeNull();
  });

  it('does not loop forever on a zero-width regex match', () => {
    // 'a*' matches empty strings between characters; those are skipped, real runs kept.
    expect(findRanges('baa', 'a*', flags({ regex: true }))).toEqual([{ start: 1, end: 3 }]);
  });
});

describe('findInDocument', () => {
  // Sliced from the ALIGNED scan text — the offset space a match is expressed in
  // and the one surface.replaceMatch applies it to. Slicing plain text instead
  // would silently agree with a match whose offsets had drifted past an atom.
  const sliceOf = (blocks: BlockNode[], blockId: string, start: number, end: number): string => {
    const found = findLeaf(blocks, blockId);
    return found ? inlineScanText(found.inline).slice(start, end) : '';
  };

  function findLeaf(
    blocks: BlockNode[],
    id: string
  ): Extract<BlockNode, { type: 'paragraph' | 'heading' }> | null {
    for (const b of blocks) {
      if ((b.type === 'paragraph' || b.type === 'heading') && b.id === id) return b;
      if (b.type === 'blockquote') {
        const inner = findLeaf(b.children, id);
        if (inner) return inner;
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        for (const item of b.items) {
          const inner = findLeaf(item.children, id);
          if (inner) return inner;
        }
      }
    }
    return null;
  }

  it('matches inline-text leaves at every depth, in document order, never crossing blocks', () => {
    const { blocks } = parseDocument(
      ['the cat sat', '# the heading', '- the item', '> the quote'].join('\n\n')
    );
    const matches = findInDocument(blocks, 'the', flags());

    expect(matches).toHaveLength(4); // paragraph, heading, list item, blockquote
    // Each match resolves to the literal query in its own block.
    for (const m of matches) expect(sliceOf(blocks, m.blockId, m.start, m.end)).toBe('the');
    // Four distinct blocks, in document order (the walk order).
    expect(new Set(matches.map((m) => m.blockId)).size).toBe(4);
  });

  it('reports multiple matches within one block', () => {
    const { blocks } = parseDocument('the other theory');
    const matches = findInDocument(blocks, 'the', flags());
    expect(matches.map((m) => [m.start, m.end])).toEqual([
      [0, 3],
      [5, 8],
      [10, 13]
    ]);
    expect(new Set(matches.map((m) => m.blockId)).size).toBe(1);
  });

  it('skips barrier blocks (code) that carry no inline-text leaf', () => {
    const { blocks } = parseDocument(['the prose', '```', 'the code', '```'].join('\n'));
    const matches = findInDocument(blocks, 'the', flags());
    expect(matches).toHaveLength(1);
    expect(sliceOf(blocks, matches[0]!.blockId, matches[0]!.start, matches[0]!.end)).toBe('the');
  });

  it('returns nothing for an empty query', () => {
    const { blocks } = parseDocument('the cat');
    expect(findInDocument(blocks, '', flags())).toEqual([]);
  });

  // A single-cell atom (image / hard break / footnote reference) holds one cell in
  // the flat offset space. Matching over plain text — which drops atoms — shifted
  // every later match left by one per atom, so the highlight drifted and replace
  // edited the wrong characters.
  describe('with single-cell atoms in the leaf', () => {
    it('offsets a match past an image by the atom cell', () => {
      const { blocks } = parseDocument('ab ![x](a.png) the cat');
      const matches = findInDocument(blocks, 'the', flags());
      expect(matches).toHaveLength(1);
      // "ab " (3) + image (1) + " " (1) = 5, not 4.
      expect([matches[0]!.start, matches[0]!.end]).toEqual([5, 8]);
      expect(sliceOf(blocks, matches[0]!.blockId, matches[0]!.start, matches[0]!.end)).toBe('the');
    });

    it('offsets a match past a hard break by the atom cell', () => {
      const { blocks } = parseDocument('ab\\\nthe cat');
      const matches = findInDocument(blocks, 'the', flags());
      expect(matches).toHaveLength(1);
      expect([matches[0]!.start, matches[0]!.end]).toEqual([3, 6]); // "ab" (2) + break (1)
      expect(sliceOf(blocks, matches[0]!.blockId, matches[0]!.start, matches[0]!.end)).toBe('the');
    });

    it('accumulates one cell per atom across several', () => {
      const { blocks } = parseDocument('![x](a.png)![y](b.png) the');
      const matches = findInDocument(blocks, 'the', flags());
      expect([matches[0]!.start, matches[0]!.end]).toEqual([3, 6]); // two atoms + " "
    });

    it('does not join the text on either side of an atom into a phantom match', () => {
      // Plain text collapsed this to "abcd" and reported a match that spans an image.
      const { blocks } = parseDocument('ab![x](a.png)cd');
      expect(findInDocument(blocks, 'abcd', flags())).toEqual([]);
    });

    it('drops a regex match that would span an atom', () => {
      // `.` matches the atom placeholder; replacing such a range would delete the
      // image outright, so the match is refused rather than offered.
      const { blocks } = parseDocument('a![x](a.png)b');
      expect(findInDocument(blocks, 'a.b', flags({ regex: true }))).toEqual([]);
      // A regex match that stays clear of the atom is still reported.
      const { blocks: clear } = parseDocument('![x](a.png)azb');
      const matches = findInDocument(clear, 'a.b', flags({ regex: true }));
      expect([matches[0]!.start, matches[0]!.end]).toEqual([1, 4]);
    });

    it('still matches text inside an inline code span', () => {
      // Find searches code spans; only atoms are masked, never code.
      const { blocks } = parseDocument('run `the command`');
      expect(findInDocument(blocks, 'the', flags())).toHaveLength(1);
    });
  });
});

describe('replaceRangesInString', () => {
  it('replaces every range, preserving the gaps', () => {
    const text = 'the the the';
    const ranges = findRanges(text, 'the', flags());
    expect(replaceRangesInString(text, ranges, 'xy')).toBe('xy xy xy');
  });

  it('handles a longer replacement without offset drift', () => {
    const text = 'a-a-a';
    const ranges = findRanges(text, 'a', flags());
    expect(replaceRangesInString(text, ranges, 'BBB')).toBe('BBB-BBB-BBB');
  });

  it('returns the text unchanged when there are no ranges', () => {
    expect(replaceRangesInString('untouched', [], 'x')).toBe('untouched');
  });
});
