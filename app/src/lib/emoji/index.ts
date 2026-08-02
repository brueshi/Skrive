// The emoji dataset, loaded on demand.
//
// WHY IT IS LAZY. The source data is ~730KB raw (emojibase's compact catalog
// plus its shortcode map). That must never sit in the main bundle: it is needed
// only once a writer opens the picker, and the editor's cost model treats the
// keystroke path as sacred. A dynamic import puts the whole thing in its own
// chunk that is fetched at most once per session, on the first open.
//
// WHY emojibase RATHER THAN A HAND-ROLLED TABLE. Emoji tracks Unicode releases
// indefinitely — new characters, new shortcodes, changed labels, every year.
// That is exactly the case where a maintained dataset beats owning the problem,
// as opposed to the small stable surfaces this codebase deliberately hand-rolls.
//
// The normalization here is not incidental. emojibase ships two files keyed by
// hexcode, includes non-displayable component characters, and nests skin-tone
// variants; the picker wants one flat list of things a writer can actually
// insert. Doing that join once at load keeps ./search.ts pure and the component
// dumb.

import { searchEmoji, type EmojiEntry } from './search';

export { searchEmoji, SEARCH_LIMIT, type EmojiEntry } from './search';

/** CLDR group ids, in the order the browse grid shows them. Group 2 (Component)
 *  is deliberately absent: it holds bare skin-tone and hair modifiers, which are
 *  not emoji anyone inserts on their own. */
export const EMOJI_GROUPS: { id: number; name: string }[] = [
  { id: 0, name: 'Smileys & Emotion' },
  { id: 1, name: 'People & Body' },
  { id: 3, name: 'Animals & Nature' },
  { id: 4, name: 'Food & Drink' },
  { id: 5, name: 'Travel & Places' },
  { id: 6, name: 'Activities' },
  { id: 7, name: 'Objects' },
  { id: 8, name: 'Symbols' },
  { id: 9, name: 'Flags' }
];

const COMPONENT_GROUP = 2;

// The shape emojibase's compact.json actually has. Declared locally rather than
// imported from the package's own types: only these fields are read, and an
// entry with no `group` is a component character this module drops anyway.
type CompactEmoji = {
  hexcode: string;
  label: string;
  unicode: string;
  group?: number;
  order?: number;
  tags?: string[];
};

/** emojibase keys shortcodes by hexcode and stores a bare string when there is
 *  only one. Normalized to an array so callers never branch. */
type ShortcodeMap = Record<string, string | string[]>;

function shortcodesFor(map: ShortcodeMap, hexcode: string): string[] {
  const raw = map[hexcode];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Join emojibase's two files into the flat, insertable list the picker wants.
 * Exported for tests, which drive it with fixtures rather than the real files.
 */
export function normalizeEmoji(compact: CompactEmoji[], shortcodes: ShortcodeMap): EmojiEntry[] {
  const out: EmojiEntry[] = [];
  for (const e of compact) {
    // No group means a component character (bare skin-tone modifiers, regional
    // indicator letters) — not something to offer on its own.
    if (e.group == null || e.group === COMPONENT_GROUP) continue;
    out.push({
      char: e.unicode,
      label: e.label,
      group: e.group,
      order: e.order ?? 0,
      shortcodes: shortcodesFor(shortcodes, e.hexcode),
      tags: (e.tags ?? []).map((t) => t.toLowerCase())
    });
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

// Resolved once and reused. The in-flight promise is cached too, so two opens in
// the same tick share one fetch instead of racing two parses.
let cached: EmojiEntry[] | null = null;
let inflight: Promise<EmojiEntry[]> | null = null;

/** The full catalog, fetching it on first call. Safe to call on every open. */
export function loadEmoji(): Promise<EmojiEntry[]> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = Promise.all([
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/en/shortcodes/emojibase.json')
  ])
    .then(([compact, codes]) => {
      const entries = normalizeEmoji(
        (compact.default ?? compact) as CompactEmoji[],
        (codes.default ?? codes) as ShortcodeMap
      );
      cached = entries;
      return entries;
    })
    .finally(() => {
      // Clear either way: a failed load must be retryable on the next open
      // rather than sticking a rejected promise to every future call.
      inflight = null;
    });
  return inflight;
}

/** Already-loaded catalog, or null. Lets a component render synchronously on
 *  reopen instead of flashing a loading state for data it already has. */
export function loadedEmoji(): EmojiEntry[] | null {
  return cached;
}

/** Convenience for the common "load, then rank" call. */
export async function searchEmojiAsync(query: string, limit?: number): Promise<EmojiEntry[]> {
  return searchEmoji(await loadEmoji(), query, limit);
}
