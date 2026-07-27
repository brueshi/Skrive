// Resolving a daily note: where today's file lives and what it starts with.
//
// Both inputs are user-authored settings strings, so everything here treats
// them as untrusted: the pattern is sanitised into a safe project-relative
// path, and an unusable pattern resolves to null rather than to a plausible
// wrong path the caller would then silently create.

import type { DailyNoteFormat } from '@skrive/shared';
import { formatDate, sanitizeRelPath } from './date-format';

/** File extension a daily note carries, by format. */
export function dailyNoteExtension(format: DailyNoteFormat): string {
  return format === 'folio' ? '.folio' : '.md';
}

/** Token in a daily-note template, replaced with the note's own date
 *  rendered through the configured pattern — so the heading a note opens
 *  with matches the name it was filed under. */
const DATE_TOKEN = /\{\{date\}\}/g;

/** Project-relative path of the daily note for `date`, or null when the
 *  pattern yields nothing usable as a filename.
 *
 *  A pattern containing slashes nests (`YYYY/MM/DD` files by year and
 *  month); the shell's newFile and writeFile both create missing parents,
 *  so nesting needs no separate mkdir. */
export function dailyNotePath(
  date: Date,
  folder: string,
  pattern: string,
  format: DailyNoteFormat
): string | null {
  const name = sanitizeRelPath(formatDate(date, pattern));
  if (name.length === 0) return null;
  const dir = sanitizeRelPath(folder);
  const rel = dir.length > 0 ? `${dir}/${name}` : name;
  // The extension comes from the format preference, never from the pattern:
  // a pattern says what a note is called, not what kind of file it is.
  const ext = dailyNoteExtension(format);
  return rel.toLowerCase().endsWith(ext) ? rel : `${rel}${ext}`;
}

/** Expand a daily-note template for `date`. */
export function renderDailyTemplate(
  template: string,
  date: Date,
  pattern: string
): string {
  return template.replace(DATE_TOKEN, formatDate(date, pattern));
}
