// The `.folio` reader's tolerance and forward-refusal behavior (SKR-195, spec §1).

import { describe, expect, it } from 'vitest';
import {
  FolioForwardError,
  FolioParseError,
  parseFolio,
  serializeFolio
} from '../../src/lib/folio';
import { EMPTY_DOC_ID, RICH_DOC_ID } from './fixture';

describe('parseFolio forward-refusal (spec §1)', () => {
  it('refuses a newer schemaVersion without partial-parsing', () => {
    const text = JSON.stringify({ schemaVersion: 2, docId: 'x', docMeta: {}, blocks: [] });
    expect(() => parseFolio(text)).toThrow(FolioForwardError);
  });

  it('refuses a v2 zip container by its PK magic', () => {
    // A zip file decoded as text begins with the local-file-header magic.
    expect(() => parseFolio('PKrest-of-a-zip')).toThrow(FolioForwardError);
  });

  it('refuses a PK magic even behind leading whitespace', () => {
    expect(() => parseFolio('  \nPK')).toThrow(FolioForwardError);
  });
});

describe('parseFolio malformed input (spec §1)', () => {
  it('rejects non-JSON', () => {
    expect(() => parseFolio('not json at all')).toThrow(FolioParseError);
  });

  it('rejects a truncated JSON object', () => {
    expect(() => parseFolio('{ "schemaVersion": 1, ')).toThrow(FolioParseError);
  });

  it('rejects an unknown block type rather than dropping it', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      docId: 'x',
      docMeta: { title: null, createdAt: '' },
      blocks: [{ id: 'a', type: 'callout', inline: [] }]
    });
    expect(() => parseFolio(text)).toThrow(FolioParseError);
  });

  it('rejects a block missing its id', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      docId: 'x',
      docMeta: { title: null, createdAt: '' },
      blocks: [{ type: 'paragraph', inline: [] }]
    });
    expect(() => parseFolio(text)).toThrow(FolioParseError);
  });
});

describe('parseFolio docMeta unknown-key preservation (spec §4)', () => {
  it('preserves a newer writer\'s docMeta keys across a round trip', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      docId: EMPTY_DOC_ID,
      docMeta: { title: 'T', createdAt: '2026-07-02T00:00:00.000Z', wordCount: 42, tags: ['a', 'b'] },
      blocks: []
    });
    const parsed = parseFolio(text);
    expect(parsed.docMeta.wordCount).toBe(42);
    expect(parsed.docMeta.tags).toEqual(['a', 'b']);
    // ...and they survive re-serialization, appended after the known keys.
    const out = serializeFolio(parsed);
    expect(out.indexOf('"createdAt"')).toBeLessThan(out.indexOf('"wordCount"'));
    expect(JSON.parse(out).docMeta.wordCount).toBe(42);
  });

  it('treats docId as opaque (does not reject a non-canonical id)', () => {
    // The spec's own rich fixture uses a docId containing "u", which canonical
    // Crockford excludes — the reader must accept it.
    const text = JSON.stringify({
      schemaVersion: 1,
      docId: RICH_DOC_ID,
      docMeta: { title: null, createdAt: '' },
      blocks: []
    });
    expect(parseFolio(text).docId).toBe(RICH_DOC_ID);
  });
});
