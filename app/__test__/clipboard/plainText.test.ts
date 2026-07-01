// Plain-text paste segmentation (SKR-148): CommonMark paragraph semantics for
// markup-free text. Blank lines separate paragraphs; single newlines are soft
// breaks that flow as spaces; line edges shed incidental whitespace from
// hard-wrapped sources.

import { describe, expect, it } from 'vitest';
import { plainTextParagraphs } from '../../src/lib/clipboard/plainText';

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
