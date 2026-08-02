// Emoji ranking and normalization. Both are pure, so these run against small
// fixtures rather than the real 1900-entry dataset — the dataset is a dynamic
// import and its contents are emojibase's problem, not ours.
//
// What is worth pinning is the ordering, because a flat substring match puts the
// wrong emoji first for the queries writers actually type: "smile" must not lead
// with "smiling cat", and a shortcode a writer already knows must beat a loose
// tag association.

import { describe, expect, it } from 'vitest';
import { normalizeEmoji, EMOJI_GROUPS } from '../../src/lib/emoji';
import { searchEmoji, type EmojiEntry } from '../../src/lib/emoji/search';

function entry(over: Partial<EmojiEntry> & { char: string; label: string }): EmojiEntry {
  return { group: 0, order: 0, shortcodes: [], tags: [], ...over };
}

const GRIN = entry({ char: '😀', label: 'grinning face', order: 1, shortcodes: ['grinning'], tags: ['smile', 'happy'] });
const SMILE = entry({ char: '😄', label: 'grinning face with smiling eyes', order: 2, shortcodes: ['smile'], tags: ['happy'] });
const CAT = entry({ char: '😸', label: 'grinning cat with smiling eyes', order: 3, shortcodes: ['smile_cat'], tags: ['smile'] });
const WAVE = entry({ char: '👋', label: 'waving hand', order: 4, shortcodes: ['wave'], tags: ['hello', 'bye', 'hand'] });
const OCEAN = entry({ char: '🌊', label: 'water wave', order: 5, shortcodes: ['ocean'], tags: ['wave', 'sea'] });

const ALL = [GRIN, SMILE, CAT, WAVE, OCEAN];

describe('searchEmoji', () => {
  it('returns everything in catalog order for an empty query — the browse case', () => {
    expect(searchEmoji(ALL, '')).toEqual(ALL);
    expect(searchEmoji(ALL, '   ')).toEqual(ALL);
  });

  it('puts an exact shortcode first', () => {
    // "smile" is CAT's tag and SMILE's shortcode; the shortcode wins.
    expect(searchEmoji(ALL, 'smile')[0]).toBe(SMILE);
  });

  it('prefers a shortcode prefix over a loose tag match', () => {
    // "wave" is WAVE's shortcode and OCEAN's tag.
    expect(searchEmoji(ALL, 'wave')[0]).toBe(WAVE);
  });

  it('matches a word inside the label', () => {
    expect(searchEmoji(ALL, 'hand')).toContain(WAVE);
  });

  it('matches a tag that no label contains', () => {
    expect(searchEmoji(ALL, 'hello')).toContain(WAVE);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(searchEmoji(ALL, '  SMILE ')[0]).toBe(SMILE);
  });

  it('excludes entries that match nothing', () => {
    expect(searchEmoji(ALL, 'wave')).not.toContain(GRIN);
    expect(searchEmoji(ALL, 'zzzz')).toEqual([]);
  });

  it('breaks ties by catalog order, so results never reshuffle between keystrokes', () => {
    const results = searchEmoji(ALL, 'grinning');
    const orders = results.map((r) => r.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('respects the limit', () => {
    expect(searchEmoji(ALL, 'grinning', 2)).toHaveLength(2);
  });
});

describe('normalizeEmoji', () => {
  const compact = [
    { hexcode: '1F44B', label: 'waving hand', unicode: '👋', group: 1, order: 188, tags: ['Hello', 'BYE'] },
    { hexcode: '1F600', label: 'grinning face', unicode: '😀', group: 0, order: 1, tags: ['smile'] },
    // No group: a component character (a bare regional indicator).
    { hexcode: '1F1E6', label: 'regional indicator A', unicode: '🇦' },
    // Group 2 is Component — bare skin-tone modifiers.
    { hexcode: '1F3FB', label: 'light skin tone', unicode: '🏻', group: 2, order: 5 }
  ];
  const shortcodes = { '1F44B': 'wave', '1F600': ['grinning', 'grin'] };

  it('drops component characters and entries with no group', () => {
    const out = normalizeEmoji(compact, shortcodes);
    expect(out.map((e) => e.char)).toEqual(['😀', '👋']);
  });

  it('normalizes a bare shortcode string into an array', () => {
    const wave = normalizeEmoji(compact, shortcodes).find((e) => e.char === '👋')!;
    expect(wave.shortcodes).toEqual(['wave']);
  });

  it('keeps multiple shortcodes', () => {
    const grin = normalizeEmoji(compact, shortcodes).find((e) => e.char === '😀')!;
    expect(grin.shortcodes).toEqual(['grinning', 'grin']);
  });

  it('lowercases tags so the matcher never has to', () => {
    const wave = normalizeEmoji(compact, shortcodes).find((e) => e.char === '👋')!;
    expect(wave.tags).toEqual(['hello', 'bye']);
  });

  it('sorts by catalog order', () => {
    const out = normalizeEmoji(compact, shortcodes);
    expect(out.map((e) => e.order)).toEqual([1, 188]);
  });

  it('tolerates an entry with no shortcodes or tags', () => {
    const out = normalizeEmoji([{ hexcode: 'X', label: 'x', unicode: 'x', group: 8, order: 1 }], {});
    expect(out[0]).toMatchObject({ shortcodes: [], tags: [] });
  });
});

describe('EMOJI_GROUPS', () => {
  it('omits the Component group, which holds no insertable emoji', () => {
    expect(EMOJI_GROUPS.map((g) => g.id)).not.toContain(2);
  });

  it('is in ascending id order, matching the catalog sort', () => {
    const ids = EMOJI_GROUPS.map((g) => g.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});
