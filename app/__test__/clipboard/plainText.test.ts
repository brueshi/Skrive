// Plain-text paste segmentation (SKR-148): CommonMark paragraph semantics for
// markup-free text. Blank lines separate paragraphs; single newlines are soft
// breaks that flow as spaces; line edges shed incidental whitespace from
// hard-wrapped sources.

import { describe, expect, it } from 'vitest';
import { literalParagraphs, plainTextParagraphs } from '../../src/lib/clipboard/plainText';

describe('plainTextParagraphs', () => {
  it('flows hard-wrapped prose into one paragraph, trimming line edges', () => {
    const raw = [
      'The Electron-to-Zig shell port proved the host layer can be native. That raises a',
      'strategic',
      'question the shell port deliberately did not answer: if the long-term direction is',
      ' "more native,"'
    ].join('\n');
    expect(plainTextParagraphs(raw)).toEqual([
      'The Electron-to-Zig shell port proved the host layer can be native. That raises a strategic question the shell port deliberately did not answer: if the long-term direction is "more native,"'
    ]);
  });

  it('splits paragraphs on blank lines, including whitespace-only ones', () => {
    expect(plainTextParagraphs('first\npara\n\nsecond\n   \nthird')).toEqual([
      'first para',
      'second',
      'third'
    ]);
  });

  it('collapses runs of blank lines into a single seam', () => {
    expect(plainTextParagraphs('a\n\n\n\nb')).toEqual(['a', 'b']);
  });

  it('normalizes CRLF line endings', () => {
    expect(plainTextParagraphs('one\r\ntwo\r\n\r\nthree')).toEqual(['one two', 'three']);
  });

  it('drops leading and trailing blank lines', () => {
    expect(plainTextParagraphs('\n\n  \nonly one\n\n')).toEqual(['only one']);
  });

  it('returns nothing for whitespace-only input', () => {
    expect(plainTextParagraphs('')).toEqual([]);
    expect(plainTextParagraphs(' \n \n ')).toEqual([]);
  });
});

// SKR-185 / F28 — the literal path must reproduce what was copied. The old
// implementation `split(/\n+/)`-ed, which erased every distinction these cases
// depend on: a blank line vs a single newline, an indented line vs a trimmed one.
describe('literalParagraphs', () => {
  it('makes a paragraph per blank-line-separated block', () => {
    expect(literalParagraphs('a\n\nb')).toEqual(['a', 'b']);
  });

  it('keeps a single newline inside its paragraph (it becomes a hard break)', () => {
    expect(literalParagraphs('a\nb')).toEqual(['a\nb']);
  });

  it('distinguishes a break from a paragraph seam', () => {
    expect(literalParagraphs('a\nb\n\nc')).toEqual(['a\nb', 'c']);
  });

  it('preserves leading indentation, which the flow path trims away', () => {
    expect(literalParagraphs('def f():\n    return 1')).toEqual(['def f():\n    return 1']);
    expect(plainTextParagraphs('def f():\n    return 1')).toEqual(['def f(): return 1']);
  });

  it('preserves trailing whitespace on a line', () => {
    expect(literalParagraphs('a  \nb')).toEqual(['a  \nb']);
  });

  it('normalizes CRLF to a newline', () => {
    expect(literalParagraphs('a\r\nb')).toEqual(['a\nb']);
  });

  // The old path deleted a lone \r outright, silently gluing the lines together.
  it('treats a lone CR as a newline rather than deleting it', () => {
    expect(literalParagraphs('a\rb')).toEqual(['a\nb']);
    expect(literalParagraphs('a\r\rb')).toEqual(['a', 'b']);
  });

  it('drops exactly one trailing newline, the line-copy artifact', () => {
    expect(literalParagraphs('a\n')).toEqual(['a']);
  });

  // Copying "a" plus a blank line leaves one newline after the strip, so the text
  // keeps a trailing hard break rather than gaining an empty paragraph. The break
  // survives in `.folio` and is dropped by the Markdown floor (F15), which is the
  // same treatment a trailing Shift+Enter gets.
  it('a copied blank line becomes a trailing break, not an empty paragraph', () => {
    expect(literalParagraphs('a\n\n')).toEqual(['a\n']);
  });

  it('keeps an interior blank line as an empty leading segment', () => {
    expect(literalParagraphs('\n\na')).toEqual(['', 'a']);
  });

  it('collapses three or more blank lines to one seam (no empty paragraph exists)', () => {
    expect(literalParagraphs('a\n\n\n\nb')).toEqual(['a', 'b']);
  });

  it('returns the text unchanged when there is nothing to segment', () => {
    expect(literalParagraphs('just one line')).toEqual(['just one line']);
  });
});
