// Ranking a query against the emoji index. Pure and dataset-free by design: it
// takes entries in, so it is testable against a handful of fixtures rather than
// against 1900 real ones, and the loader can stay an I/O concern (./index.ts).
//
// Ranking exists because a flat substring match puts the wrong emoji first for
// the queries writers actually type. "smile" should not lead with "smiley cat",
// and ":wave" should be the waving hand rather than the first of a dozen things
// tagged "wave". Shortcodes are the strongest signal (a writer typing `:` is
// reaching for a name they already know), then the label, then the tag cloud —
// which is broad, associative, and would otherwise drown the obvious answer.

export type EmojiEntry = {
  /** The literal Unicode character, which is the whole payload of the feature. */
  char: string;
  /** Human-readable name, e.g. "waving hand". */
  label: string;
  /** CLDR group id, for the browse grid's sections. */
  group: number;
  /** CLDR sort order within the full catalog. The stable tiebreak everywhere. */
  order: number;
  /** Shortcode names, e.g. ["wave"]. May be empty. */
  shortcodes: string[];
  /** Associative keywords, e.g. ["bye", "hello", "hi"]. */
  tags: string[];
};

// Tiers, best first. The numbers are only compared to each other.
const EXACT_SHORTCODE = 0;
const PREFIX_SHORTCODE = 1;
const EXACT_LABEL = 2;
const PREFIX_LABEL = 3;
const EXACT_TAG = 4;
const PREFIX_WORD = 5; // a word inside the label starts with the query
const SUBSTRING = 6;
const NO_MATCH = 7;

/** How well one entry answers `q` (already lowercased and trimmed). Lower is
 *  better; NO_MATCH means it should not appear at all. */
function tierOf(entry: EmojiEntry, q: string): number {
  for (const code of entry.shortcodes) {
    if (code === q) return EXACT_SHORTCODE;
  }
  for (const code of entry.shortcodes) {
    if (code.startsWith(q)) return PREFIX_SHORTCODE;
  }
  const label = entry.label.toLowerCase();
  if (label === q) return EXACT_LABEL;
  if (label.startsWith(q)) return PREFIX_LABEL;
  for (const tag of entry.tags) {
    if (tag === q) return EXACT_TAG;
  }
  // A word boundary inside the label: "waving hand" should be found by "hand".
  for (const word of label.split(/[\s-]+/)) {
    if (word.startsWith(q)) return PREFIX_WORD;
  }
  for (const tag of entry.tags) {
    if (tag.startsWith(q)) return PREFIX_WORD;
  }
  if (label.includes(q)) return SUBSTRING;
  return NO_MATCH;
}

/** Default cap on returned matches. The grid scrolls, but an unbounded result
 *  set for a one-character query is thousands of nodes for no benefit. */
export const SEARCH_LIMIT = 120;

/**
 * Entries matching `query`, best first. An empty query returns everything in
 * catalog order — that is the browse case, and the caller (the grid) sections it
 * by group rather than truncating it.
 *
 * Ties break by CLDR `order`, so equally-ranked results keep the ordering the
 * Unicode data intends and the list never reshuffles between keystrokes.
 */
export function searchEmoji(
  entries: EmojiEntry[],
  query: string,
  limit: number = SEARCH_LIMIT
): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;

  const scored: { entry: EmojiEntry; tier: number }[] = [];
  for (const entry of entries) {
    const tier = tierOf(entry, q);
    if (tier !== NO_MATCH) scored.push({ entry, tier });
  }
  scored.sort((a, b) => a.tier - b.tier || a.entry.order - b.entry.order);
  return scored.slice(0, limit).map((s) => s.entry);
}
