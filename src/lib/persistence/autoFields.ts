// Auto-updating frontmatter fields.
//
// On every save the auto-save driver refreshes three fields, but *only
// for files that already have them*:
//
//   - last_modified → current ISO 8601 timestamp
//   - word_count    → whitespace-separated tokens in the body
//   - reading_time  → minutes, rounded, floored at 1
//
// The present-only rule is deliberate. Skrive does not invent
// frontmatter for files that have chosen not to use it. Prose writers
// get a clean file forever; technical writers who want these fields
// include them once and Skrive maintains them thereafter. A later
// `.skrive.toml` setting may add a project-wide "inject these fields on
// save" mode, but it stays opt-in.
//
// Word count is a whitespace split with empty tokens filtered. We do
// *not* strip Markdown syntax (heading hashes, fenced code, link URLs,
// HTML) for v1, so a body heavy with code or link noise will report
// more tokens than a human reader would count. This is accepted — the
// field is a hint, not a contract, and the 200 wpm constant already
// has huge error bars.

const FIELD_LAST_MODIFIED = "last_modified";
const FIELD_WORD_COUNT = "word_count";
const FIELD_READING_TIME = "reading_time";

const WORDS_PER_MINUTE = 200;

export function computeWordCount(body: string): number {
  if (!body) return 0;
  // Split on any run of whitespace (spaces, tabs, newlines). `filter(Boolean)`
  // drops empties from leading / trailing / collapsed whitespace runs.
  return body.split(/\s+/).filter(Boolean).length;
}

export function computeReadingTime(wordCount: number): number {
  if (wordCount <= 0) return 1;
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}

/**
 * Mutate `frontmatter` in place to refresh the auto-updated fields that
 * already exist in it. Fields that aren't present are left alone.
 *
 * Called by the auto-save driver at the moment of write, so the values
 * reflect the final debounced state and not any intermediate keystroke.
 * Mutation is by reference: the frontmatter object here is the same one
 * held by `Tab.content.frontmatter` in the project store, so the panel
 * UI sees updated values automatically through Svelte's reactive proxy.
 */
export function stampAutoFields(
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  let wordCount: number | null = null;

  if (FIELD_LAST_MODIFIED in frontmatter) {
    frontmatter[FIELD_LAST_MODIFIED] = new Date().toISOString();
  }
  if (FIELD_WORD_COUNT in frontmatter) {
    wordCount = computeWordCount(body);
    frontmatter[FIELD_WORD_COUNT] = wordCount;
  }
  if (FIELD_READING_TIME in frontmatter) {
    if (wordCount === null) wordCount = computeWordCount(body);
    frontmatter[FIELD_READING_TIME] = computeReadingTime(wordCount);
  }
}
