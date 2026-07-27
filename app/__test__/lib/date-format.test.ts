// Date patterns for daily notes are user-authored and end up as filenames,
// so these tests lean on the ways a writer's pattern can go wrong rather
// than on the happy path.

import { describe, expect, it } from 'vitest';
import { formatDate, sanitizeRelPath } from '../../src/lib/date-format';

// A Sunday, single-digit month and day, so padding and weekday both show.
const EARLY = new Date(2026, 2, 8, 9, 5, 3);
// A Thursday in a two-digit month.
const LATE = new Date(2026, 10, 26, 14, 30, 45);

describe('formatDate', () => {
  it('renders the numeric tokens with padding', () => {
    expect(formatDate(EARLY, 'YYYY-MM-DD')).toBe('2026-03-08');
    expect(formatDate(LATE, 'YYYY-MM-DD')).toBe('2026-11-26');
  });

  it('renders unpadded variants', () => {
    expect(formatDate(EARLY, 'D/M/YY')).toBe('8/3/26');
  });

  it('renders month and weekday names', () => {
    expect(formatDate(EARLY, 'dddd, D MMMM YYYY')).toBe('Sunday, 8 March 2026');
    expect(formatDate(LATE, 'ddd D MMM')).toBe('Thu 26 Nov');
  });

  it('renders time tokens', () => {
    expect(formatDate(EARLY, 'HH:mm:ss')).toBe('09:05:03');
    expect(formatDate(LATE, 'HH:mm')).toBe('14:30');
  });

  // The reason bracket escaping exists at all. Without it the D in "Daily"
  // is read as day-of-month and the pattern silently produces "8aily-2026".
  it('passes bracketed text through untouched', () => {
    expect(formatDate(EARLY, '[Daily]-YYYY')).toBe('Daily-2026');
    expect(formatDate(EARLY, '[Notes for] dddd')).toBe('Notes for Sunday');
  });

  it('shows what unescaped literal text does, so the escape is justified', () => {
    expect(formatDate(EARLY, 'Daily-YYYY')).toBe('8aily-2026');
  });

  it('leaves an empty escape as nothing', () => {
    expect(formatDate(EARLY, 'YYYY[]MM')).toBe('202603');
  });

  it('passes unrecognised characters through', () => {
    // Lowercase d and m are not tokens on their own (only ddd/dddd and mm
    // are), so a trailing ".md" survives a pattern unescaped. This is what
    // lets dailyNotePath treat the extension as ordinary text.
    expect(formatDate(EARLY, 'YYYY_MM_DD.md')).toBe('2026_03_08.md');
    expect(formatDate(EARLY, '')).toBe('');
  });

  it('still tokenises uppercase letters sitting inside literal text', () => {
    // ".MD" is month-then-day, not an extension — the sharpest reason the
    // bracket escape exists.
    expect(formatDate(EARLY, 'note.MD')).toBe('note.38');
    expect(formatDate(EARLY, '[note.MD]')).toBe('note.MD');
  });

  it('does not re-tokenise its own output', () => {
    // March renders "March"; the M and the a must not be reconsidered.
    expect(formatDate(EARLY, 'MMMM')).toBe('March');
  });
});

describe('sanitizeRelPath', () => {
  // Hyphens and spaces are ordinary in a date pattern. An over-broad
  // illegal-character class would quietly turn YYYY-MM-DD into YYYYMMDD.
  it('keeps hyphens and inner spaces', () => {
    expect(sanitizeRelPath('2026-03-08')).toBe('2026-03-08');
    expect(sanitizeRelPath('March 8 2026')).toBe('March 8 2026');
  });

  it('keeps nesting', () => {
    expect(sanitizeRelPath('2026/03/08')).toBe('2026/03/08');
    expect(sanitizeRelPath('Daily/2026')).toBe('Daily/2026');
  });

  it('normalises backslashes and collapses empty segments', () => {
    expect(sanitizeRelPath('Daily\\2026\\03')).toBe('Daily/2026/03');
    expect(sanitizeRelPath('//Daily//2026//')).toBe('Daily/2026');
  });

  it('drops traversal and dot segments', () => {
    expect(sanitizeRelPath('../../etc/passwd')).toBe('etc/passwd');
    expect(sanitizeRelPath('Daily/../../..')).toBe('Daily');
    expect(sanitizeRelPath('./Daily/.')).toBe('Daily');
  });

  it('strips characters that are illegal in a Windows path segment', () => {
    expect(sanitizeRelPath('note<>:"|?*.md')).toBe('note.md');
  });

  it('trims segment edges', () => {
    expect(sanitizeRelPath('  Daily  /  2026  ')).toBe('Daily/2026');
  });

  it('returns empty when nothing usable survives', () => {
    expect(sanitizeRelPath('')).toBe('');
    expect(sanitizeRelPath('///')).toBe('');
    expect(sanitizeRelPath('..')).toBe('');
    expect(sanitizeRelPath('???')).toBe('');
  });
});
