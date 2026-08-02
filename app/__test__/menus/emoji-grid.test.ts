// The emoji grid's layout arithmetic. Small, but it carries the keyboard model:
// ArrowDown adds COLUMNS to a flat index, which only lands a row below while the
// flat order and the visual order are the same sequence. If sectioning ever
// reorders one without the other, arrow navigation silently jumps to the wrong
// emoji — a bug that looks like a rendering glitch and isn't.

import { describe, expect, it } from 'vitest';
import { COLUMNS, flatten, toRows } from '../../src/components/editor/menus/BlockEmojiMenu';
import type { EmojiEntry } from '../../src/lib/emoji/search';

function entry(char: string, group: number, order: number): EmojiEntry {
  return { char, label: char, group, order, shortcodes: [], tags: [] };
}

/** n entries all in one group, so row-chunking can be checked in isolation. */
function run(n: number, group = 0): EmojiEntry[] {
  return Array.from({ length: n }, (_, i) => entry(`e${i}`, group, i));
}

describe('toRows — flat mode (a ranked search result)', () => {
  it('chunks into rows of COLUMNS', () => {
    const rows = toRows(run(COLUMNS * 2), false);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'emoji' && r.items.length === COLUMNS)).toBe(true);
  });

  it('leaves a short final row short rather than padding it', () => {
    const rows = toRows(run(COLUMNS + 2), false);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.kind === 'emoji' && rows[1]!.items).toHaveLength(2);
  });

  it('emits no section headers', () => {
    expect(toRows(run(5), false).some((r) => r.kind === 'header')).toBe(false);
  });

  it('handles an empty result', () => {
    expect(toRows([], false)).toEqual([]);
  });
});

describe('toRows — sectioned mode (browsing)', () => {
  const mixed = [entry('a', 0, 1), entry('b', 3, 2), entry('c', 0, 3)];

  it('groups entries under headers regardless of input order', () => {
    const rows = toRows(mixed, true);
    expect(rows[0]).toEqual({ kind: 'header', name: 'Smileys & Emotion' });
    expect(rows[1]).toMatchObject({ kind: 'emoji' });
    expect(rows[1]!.kind === 'emoji' && rows[1]!.items.map((e) => e.char)).toEqual(['a', 'c']);
  });

  it('omits a header for a group with no entries', () => {
    const names = toRows(mixed, true)
      .filter((r) => r.kind === 'header')
      .map((r) => (r.kind === 'header' ? r.name : ''));
    expect(names).toEqual(['Smileys & Emotion', 'Animals & Nature']);
  });

  it('drops entries whose group is not a browsable one', () => {
    // Group 2 is Component; EMOJI_GROUPS excludes it, so it has no section.
    const rows = toRows([entry('skin', 2, 1), entry('a', 0, 2)], true);
    expect(flatten(rows).map((e) => e.char)).toEqual(['a']);
  });
});

describe('flatten matches what the grid renders', () => {
  it('is the visual order in sectioned mode, not the input order', () => {
    const rows = toRows([entry('a', 0, 1), entry('b', 3, 2), entry('c', 0, 3)], true);
    expect(flatten(rows).map((e) => e.char)).toEqual(['a', 'c', 'b']);
  });

  it('is the input order in flat mode, so ranking survives to the grid', () => {
    const entries = run(COLUMNS + 3);
    expect(flatten(toRows(entries, false))).toEqual(entries);
  });

  it('skips headers, so a header never becomes a selectable index', () => {
    const rows = toRows([entry('a', 0, 1), entry('b', 3, 2)], true);
    expect(flatten(rows)).toHaveLength(2);
  });

  // The keyboard model, stated as an invariant: index i sits in row
  // floor(i / COLUMNS) of the emoji rows, so +COLUMNS is exactly one row down.
  it('places flat index i at row-major position i within the emoji rows', () => {
    const rows = toRows(run(COLUMNS * 3 + 4), false);
    const flat = flatten(rows);
    const emojiRows = rows.filter((r) => r.kind === 'emoji');
    flat.forEach((item, i) => {
      const row = emojiRows[Math.floor(i / COLUMNS)];
      expect(row!.kind === 'emoji' && row!.items[i % COLUMNS]).toBe(item);
    });
  });
});
