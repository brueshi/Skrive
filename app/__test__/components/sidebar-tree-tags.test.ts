// The sidebar tag facet's derivations: tagList (the menu's Tags group) and
// filesWithTag (scoping the All list). Mirror folderList/filesInFolder — tags come
// from FileEntry.tags, which the manifest fills from .folio inline tags.

import { describe, it, expect } from 'vitest';
import type { FileEntry } from '@skrive/shared';
import { tagList, filesWithTag } from '../../src/components/sidebar/tree';

function entry(path: string, tags: string[]): FileEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    sizeBytes: 0,
    modifiedMs: 0,
    frontmatter: {},
    outgoingLinks: [],
    tags
  };
}

describe('tagList', () => {
  it('lists every tag with a document count, sorted by name', () => {
    const files = [
      entry('a.folio', ['todo', 'idea']),
      entry('b.folio', ['todo', 'project/q3']),
      entry('c.md', []) // Markdown carries no tags
    ];
    expect(tagList(files)).toEqual([
      { name: 'idea', count: 1 },
      { name: 'project/q3', count: 1 },
      { name: 'todo', count: 2 }
    ]);
  });

  it('is empty when no file carries a tag', () => {
    expect(tagList([entry('a.md', []), entry('b.folio', [])])).toEqual([]);
  });
});

describe('filesWithTag', () => {
  it('returns only the documents carrying the tag, preserving order', () => {
    const files = [
      entry('a.folio', ['todo']),
      entry('b.folio', ['idea']),
      entry('c.folio', ['todo', 'idea'])
    ];
    expect(filesWithTag(files, 'todo').map((f) => f.path)).toEqual(['a.folio', 'c.folio']);
    expect(filesWithTag(files, 'idea').map((f) => f.path)).toEqual(['b.folio', 'c.folio']);
    expect(filesWithTag(files, 'missing')).toEqual([]);
  });
});
