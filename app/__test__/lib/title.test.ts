// Sidebar / tab display-title resolution (SKR-196): the `.folio` extension is
// hidden (native format not surfaced), Markdown keeps its extension, and a
// frontmatter title still wins.

import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@skrive/shared';
import { middleTruncate, resolveTitle, stripFolioExtension } from '../../src/lib/title';

function entry(name: string, frontmatter: Record<string, unknown> = {}): FileEntry {
  return { path: name, name, sizeBytes: 0, modifiedMs: 0, frontmatter, outgoingLinks: [], tags: [] };
}

describe('stripFolioExtension', () => {
  it('hides only the .folio extension', () => {
    expect(stripFolioExtension('notes.folio')).toBe('notes');
    expect(stripFolioExtension('Trip.FOLIO')).toBe('Trip');
    expect(stripFolioExtension('todo.md')).toBe('todo.md');
    expect(stripFolioExtension('archive.folio.md')).toBe('archive.folio.md');
  });
});

describe('resolveTitle', () => {
  it('shows a .folio document without its extension', () => {
    expect(resolveTitle(entry('notes.folio'))).toEqual({ primary: 'notes', secondary: null });
  });

  it('keeps the .md extension visible', () => {
    expect(resolveTitle(entry('todo.md'))).toEqual({ primary: 'todo.md', secondary: null });
  });

  it('prefers a frontmatter title, with the (stripped) filename as secondary', () => {
    expect(resolveTitle(entry('notes.folio', { title: 'My Trip' }))).toEqual({
      primary: 'My Trip',
      secondary: 'notes'
    });
  });
});

describe('middleTruncate', () => {
  it('leaves short names alone', () => {
    expect(middleTruncate('notes.md')).toBe('notes.md');
    expect(middleTruncate('x'.repeat(40))).toBe('x'.repeat(40));
  });

  it('keeps both ends of a long name', () => {
    const name = 'A very long manuscript title — part two, chapter eleven.md';
    const out = middleTruncate(name);
    expect(out).toHaveLength(40);
    expect(out).toContain('…');
    expect(name.startsWith(out.split('…')[0]!)).toBe(true);
    expect(name.endsWith(out.split('…')[1]!)).toBe(true);
  });
});
