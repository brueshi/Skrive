// Caret-context model helpers (SKR-177). marksAtOffset resolves the formatting a
// collapsed caret inherits (Docs: the run before the caret), and linkRunAt resolves
// the whole link a caret sits inside so it can be edited from a bare caret.

import { describe, it, expect } from 'vitest';
import { marksAtOffset, linkRunAt } from '../../src/lib/blocksurface/inline-ops';
import type { InlineNode } from '../../src/lib/blockmodel';

const t = (s: string, marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'text', text: s, marks });
const link = { href: 'https://x.test', title: null };

describe('marksAtOffset', () => {
  it('returns {} for an empty run', () => {
    expect(marksAtOffset([], 0)).toEqual({});
  });

  it('reads the run before the caret (typing continues that formatting)', () => {
    const nodes = [t('ab', { strong: true }), t('cd')];
    expect(marksAtOffset(nodes, 2)).toEqual({ strong: true }); // caret after "ab": still bold
    expect(marksAtOffset(nodes, 3)).toEqual({}); // caret inside "cd": plain
  });

  it('at offset 0 reads the first run', () => {
    expect(marksAtOffset([t('ab', { em: true })], 0)).toEqual({ em: true });
  });

  it('past the end reads the last run', () => {
    expect(marksAtOffset([t('ab', { code: true })], 99)).toEqual({ code: true });
  });
});

describe('linkRunAt', () => {
  it('returns null when the caret is not in a link', () => {
    expect(linkRunAt([t('abc')], 2)).toBeNull();
    expect(linkRunAt([t('abc', { link })], 0)).toBeNull(); // offset 0: before the run
  });

  it('resolves the link range and href for a caret inside it', () => {
    const nodes = [t('go ', {}), t('here', { link })];
    // caret at offset 5 (inside "here"): the link spans [3,7).
    expect(linkRunAt(nodes, 5)).toEqual({ start: 3, end: 7, href: link.href });
  });

  it('treats the caret at the link end as inside it (char before is linked)', () => {
    const nodes = [t('here', { link }), t(' go')];
    expect(linkRunAt(nodes, 4)).toEqual({ start: 0, end: 4, href: link.href });
    expect(linkRunAt(nodes, 5)).toBeNull(); // one past: now in the plain run
  });

  it('merges contiguous runs sharing the same href into one range', () => {
    // A partially-bold link: two runs, same href — one logical link [0,6).
    const nodes = [t('ab', { link }), t('cd', { link, strong: true }), t('ef', { link })];
    expect(linkRunAt(nodes, 3)).toEqual({ start: 0, end: 6, href: link.href });
  });

  it('does not merge adjacent links with different hrefs', () => {
    const other = { href: 'https://y.test', title: null };
    const nodes = [t('ab', { link }), t('cd', { link: other })];
    expect(linkRunAt(nodes, 2)).toEqual({ start: 0, end: 2, href: link.href });
    expect(linkRunAt(nodes, 4)).toEqual({ start: 2, end: 4, href: other.href });
  });
});
