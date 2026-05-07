// Renderer-side frontmatter helpers. The parse + serialize + schema
// inference primitives live in @skrive/shared so the shell can reuse
// them during project scans; this module adds the renderer-only
// concerns: type coercion on commit, stringification for text inputs,
// and the auto-stamped fields contract (last_modified / word_count /
// reading_time, present-only).

export {
  inferSchema,
  mightHaveLeadingFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
  valueTypeName,
  type FieldInfo,
  type FrontmatterMap,
  type ParsedDocument,
  type ProjectSchema
} from '@skrive/shared';

// ============================ Auto-stamped fields ============================
//
// Every save refreshes three fields, but ONLY for files that already
// have them. The present-only rule is deliberate: Skrive doesn't invent
// frontmatter for files that opted out. Prose writers get a clean file
// forever; technical writers who want these fields include them once
// and Skrive maintains them thereafter.

const FIELD_LAST_MODIFIED = 'last_modified';
const FIELD_WORD_COUNT = 'word_count';
const FIELD_READING_TIME = 'reading_time';

const WORDS_PER_MINUTE = 200;

export function computeWordCount(body: string): number {
  if (!body) return 0;
  return body.split(/\s+/).filter(Boolean).length;
}

export function computeReadingTime(wordCount: number): number {
  if (wordCount <= 0) return 1;
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}

/**
 * Mutate the frontmatter map in place, refreshing the auto-updated
 * fields that already exist in it. Fields that aren't present are
 * left alone.
 */
export function stampAutoFields(
  frontmatter: Record<string, unknown>,
  body: string
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

// ============================ Type coercion ============================

export function valueTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

/**
 * Coerce a text input back to the original value type. Used when a
 * plain-text editor commits a new value for a field that was typed as
 * boolean / number / null so we don't silently change the underlying
 * YAML type. Unknown conversions fall back to a string so the user's
 * text is never dropped.
 */
export function coerceToOriginalType(
  text: string,
  originalType: string
): unknown {
  if (originalType === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return text;
  }
  if (originalType === 'number') {
    if (text.trim() === '') return text;
    const n = Number(text);
    if (Number.isFinite(n)) return n;
    return text;
  }
  if (originalType === 'null') {
    return text.length === 0 ? null : text;
  }
  return text;
}

/**
 * Stringify a value for display in a text input. Arrays and objects are
 * handled by other UI surfaces (chip input / read-only placeholder),
 * so this only needs to cover scalars.
 */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}
