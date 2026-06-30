// documentToPlainText (SKR-126): Markdown body -> bare prose, no syntax.

import { describe, expect, it } from 'vitest';
import { parseDocument, documentToPlainText } from '../../src/lib/blockmodel';

function plain(md: string): string {
  return documentToPlainText(parseDocument(md));
}

describe('documentToPlainText', () => {
  it('strips heading, emphasis, and inline-code syntax', () => {
    expect(plain('# Title\n\nA **bold** and *italic* and `code` line.')).toBe(
      'Title\n\nA bold and italic and code line.\n'
    );
  });

  it('drops bullet markers but keeps the text as lines', () => {
    expect(plain('- one\n- two\n- three')).toBe('one\ntwo\nthree\n');
  });

  it('keeps ordered-list numbering (sequence is content)', () => {
    expect(plain('1. first\n2. second')).toBe('1. first\n2. second\n');
    expect(plain('3. third\n4. fourth')).toBe('3. third\n4. fourth\n');
  });

  it('flattens links and images to their text/alt', () => {
    expect(plain('See [the docs](https://example.com).')).toBe('See the docs.\n');
    expect(plain('![a diagram](x.png)')).toBe('a diagram\n');
  });

  it('keeps code block contents verbatim and drops the fence', () => {
    expect(plain('```ts\nconst x = 1;\n```')).toBe('const x = 1;\n');
  });

  it('flattens a blockquote to its text', () => {
    expect(plain('> quoted line')).toBe('quoted line\n');
  });

  it('drops horizontal rules', () => {
    expect(plain('a\n\n---\n\nb')).toBe('a\n\nb\n');
  });

  it('flattens table rows to tab-separated cells', () => {
    expect(plain('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('a\tb\n1\t2\n');
  });

  it('returns empty string for an empty document', () => {
    expect(plain('')).toBe('');
  });
});
