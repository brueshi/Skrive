// folioTagNames: the exact inline-tag set read from a .folio body, for the
// manifest tag index. Sorted, de-duplicated, walks nested containers, and tolerant
// of a malformed body.

import { describe, it, expect } from 'vitest';
import { folioTagNames } from '../../src/lib/folio/tags';
import { serializeFolio } from '../../src/lib/folio/serialize';
import type { FolioDocument } from '../../src/lib/folio/types';

function folio(blocks: FolioDocument['blocks']): string {
  return serializeFolio({
    schemaVersion: 1,
    docId: 'doc_test',
    docMeta: { title: null, createdAt: '2026-01-01T00:00:00Z' },
    blocks
  });
}

const tag = (name: string) => ({ kind: 'tag' as const, name, marks: {} });
const text = (t: string) => ({ kind: 'text' as const, text: t, marks: {} });

describe('folioTagNames', () => {
  it('collects inline tags, sorted and de-duplicated', () => {
    const body = folio([
      { id: 'a', type: 'paragraph', inline: [text('see '), tag('todo'), text(' '), tag('idea')] },
      { id: 'b', type: 'paragraph', inline: [tag('todo'), tag('project/q3')] }
    ]);
    expect(folioTagNames(body)).toEqual(['idea', 'project/q3', 'todo']);
  });

  it('walks tags nested in blockquotes, lists, and table cells', () => {
    const body = folio([
      { id: 'q', type: 'blockquote', children: [{ id: 'q1', type: 'paragraph', inline: [tag('quoted')] }] },
      {
        id: 'l',
        type: 'bullet_list',
        spread: false,
        items: [{ spread: false, children: [{ id: 'li', type: 'paragraph', inline: [tag('listed')] }] }]
      },
      { id: 't', type: 'table', align: [null], rows: [[[tag('celled')]]] }
    ]);
    expect(folioTagNames(body)).toEqual(['celled', 'listed', 'quoted']);
  });

  it('returns [] for an empty or malformed body', () => {
    expect(folioTagNames('')).toEqual([]);
    expect(folioTagNames('not json')).toEqual([]);
    expect(folioTagNames('{"schemaVersion": 1}')).toEqual([]); // missing required fields
  });

  it('returns [] for a folio with no tags', () => {
    expect(folioTagNames(folio([{ id: 'a', type: 'paragraph', inline: [text('plain prose')] }]))).toEqual([]);
  });
});
