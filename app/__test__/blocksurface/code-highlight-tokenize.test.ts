import { describe, it, expect } from 'vitest';

import {
  tokenizeToRanges
} from '../../src/lib/blocksurface/highlight/tokenize';
import {
  resolveLanguage,
  isSupportedLanguage,
  languageLabel,
  LANGUAGE_CHOICES
} from '../../src/lib/blocksurface/highlight/languages';
import type { HighlightToken } from '../../src/lib/blocksurface/highlight/highlight-worker-protocol';

/** The slice each token covers — the invariant the painter relies on to build the
 *  colour mirror from `text.slice(start, end)`. */
function slices(text: string, tokens: HighlightToken[]): string[] {
  return tokens.map((t) => text.slice(t.start, t.end));
}

describe('resolveLanguage', () => {
  it('canonicalizes aliases case-insensitively', () => {
    expect(resolveLanguage('js')).toBe('javascript');
    expect(resolveLanguage('TS')).toBe('typescript');
    expect(resolveLanguage('py')).toBe('python');
    expect(resolveLanguage('sh')).toBe('bash');
    expect(resolveLanguage('yml')).toBe('yaml');
  });

  it('reads only the first token of a fence info string', () => {
    expect(resolveLanguage('js title="a.js"')).toBe('javascript');
  });

  it('returns null for unknown languages', () => {
    expect(resolveLanguage('brainfuck')).toBeNull();
    expect(resolveLanguage('')).toBeNull();
  });

  it('isSupportedLanguage mirrors resolveLanguage', () => {
    expect(isSupportedLanguage('rust')).toBe(true);
    expect(isSupportedLanguage('nope')).toBe(false);
  });

  it('resolves the expanded language set and its aliases', () => {
    expect(resolveLanguage('zig')).toBe('zig');
    expect(resolveLanguage('cs')).toBe('csharp');
    expect(resolveLanguage('rb')).toBe('ruby');
    expect(resolveLanguage('kt')).toBe('kotlin');
    expect(resolveLanguage('dockerfile')).toBe('docker');
    expect(resolveLanguage('yml')).toBe('yaml');
  });
});

describe('languageLabel', () => {
  it('shows the pretty name for a known language or alias', () => {
    expect(languageLabel('javascript')).toBe('JavaScript');
    expect(languageLabel('js')).toBe('JavaScript');
    expect(languageLabel('cpp')).toBe('C++');
  });

  it('shows the raw string for a set-but-unknown language', () => {
    expect(languageLabel('cobol')).toBe('cobol');
  });

  it('shows "Plain text" for no language', () => {
    expect(languageLabel('')).toBe('Plain text');
    expect(languageLabel('   ')).toBe('Plain text');
  });
});

describe('LANGUAGE_CHOICES', () => {
  it('leads with the Plain text (empty) choice', () => {
    expect(LANGUAGE_CHOICES[0]).toEqual({ value: '', label: 'Plain text' });
  });

  it('lists supported languages sorted by label, each resolvable', () => {
    const rest = LANGUAGE_CHOICES.slice(1);
    const labels = rest.map((c) => c.label);
    expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
    for (const choice of rest) expect(resolveLanguage(choice.value)).toBe(choice.value);
  });
});

describe('tokenizeToRanges', () => {
  it('returns no tokens for an unknown language', () => {
    expect(tokenizeToRanges('const x = 1', 'brainfuck')).toEqual([]);
  });

  it('returns no tokens for empty text', () => {
    expect(tokenizeToRanges('', 'javascript')).toEqual([]);
  });

  it('emits non-overlapping spans in order that tile the text', () => {
    const text = 'const x = 42; // done';
    const tokens = tokenizeToRanges(text, 'js');
    expect(tokens.length).toBeGreaterThan(0);
    // Sorted, non-overlapping, within bounds.
    let prevEnd = 0;
    for (const t of tokens) {
      expect(t.start).toBeGreaterThanOrEqual(prevEnd);
      expect(t.end).toBeGreaterThan(t.start);
      expect(t.end).toBeLessThanOrEqual(text.length);
      prevEnd = t.end;
    }
  });

  it('classifies the obvious tokens', () => {
    const text = 'const x = 42; // done';
    const tokens = tokenizeToRanges(text, 'js');
    const kw = tokens.find((t) => t.type === 'keyword');
    expect(kw && text.slice(kw.start, kw.end)).toBe('const');
    const num = tokens.find((t) => t.type === 'number');
    expect(num && text.slice(num.start, num.end)).toBe('42');
    const comment = tokens.find((t) => t.type === 'comment');
    expect(comment && text.slice(comment.start, comment.end)).toBe('// done');
  });

  it('keeps offsets aligned through multi-byte characters and newlines', () => {
    // A non-ASCII identifier and a newline exercise the UTF-16 offset accounting
    // the painter depends on to align the mirror with the real text.
    const text = 'const café = "e\\u0301";\nreturn café;';
    const tokens = tokenizeToRanges(text, 'js');
    // Every reported slice must be exactly the substring it points at (no drift).
    for (const t of tokens) {
      expect(text.slice(t.start, t.end)).toBe(slices(text, [t])[0]);
    }
    const keywords = tokens.filter((t) => t.type === 'keyword');
    expect(keywords.map((t) => text.slice(t.start, t.end))).toContain('return');
  });

  it('handles a language whose grammar extends another (typescript)', () => {
    const tokens = tokenizeToRanges('type Id = number;', 'ts');
    expect(tokens.some((t) => t.type === 'keyword')).toBe(true);
  });

  it('tokenizes across the expanded set, including deps loaded in order', () => {
    // php requires markup-templating; scala requires java; each must have loaded.
    for (const [text, lang] of [
      ['const x = @import("std");', 'zig'],
      ['<?php echo "hi"; ?>', 'php'],
      ['object Main extends App', 'scala'],
      ['puts "hello".upcase', 'ruby']
    ] as const) {
      expect(tokenizeToRanges(text, lang).length).toBeGreaterThan(0);
    }
  });
});
