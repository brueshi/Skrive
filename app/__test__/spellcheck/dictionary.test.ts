// The layered personal + project dictionary. Its one job is to remove
// misspellings the oracle reported, forgivingly enough that nobody has to teach
// the same word twice.

import { describe, it, expect } from 'vitest';
import { SpellDictionary } from '../../src/lib/spellcheck/dictionary';

describe('SpellDictionary', () => {
  it('matches regardless of case', () => {
    const dict = new SpellDictionary(['Atticus'], []);
    expect(dict.has('Atticus')).toBe(true);
    expect(dict.has('atticus')).toBe(true);
    expect(dict.has('ATTICUS')).toBe(true);
  });

  it('layers personal and project words into one list', () => {
    const dict = new SpellDictionary(['Skrive'], ['Yoknapatawpha']);
    expect(dict.has('skrive')).toBe(true);
    expect(dict.has('yoknapatawpha')).toBe(true);
    expect(dict.has('elsewhere')).toBe(false);
  });

  it('accepts the possessive of a taught word, with either apostrophe', () => {
    const dict = new SpellDictionary(['Atticus'], []);
    expect(dict.has("Atticus's")).toBe(true);
    expect(dict.has('Atticus’s')).toBe(true);
  });

  it('ignores blank entries and surrounding space', () => {
    const dict = new SpellDictionary([' Skrive ', '', '   '], []);
    expect(dict.size).toBe(1);
    expect(dict.has('skrive')).toBe(true);
  });

  it('treats an empty word as known, so a degenerate range never squiggles', () => {
    expect(new SpellDictionary([], []).has('')).toBe(true);
  });
});
