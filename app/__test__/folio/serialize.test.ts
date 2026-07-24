// The `.folio` writer/reader round-trip and determinism gate (SKR-195).

import { describe, expect, it } from 'vitest';
import { parseFolio, serializeFolio, type FolioDocument } from '../../src/lib/folio';
import { EMPTY_DOC_ID, emptyFixture, richFixture } from './fixture';

describe('serializeFolio / parseFolio round-trip', () => {
  it('parses back to a structurally identical document (rich fixture)', () => {
    expect(parseFolio(serializeFolio(richFixture))).toEqual(richFixture);
  });

  it('parses back to a structurally identical document (empty fixture)', () => {
    expect(parseFolio(serializeFolio(emptyFixture))).toEqual(emptyFixture);
  });

  it('a no-op save rewrites byte-identically (rich fixture)', () => {
    const text = serializeFolio(richFixture);
    expect(serializeFolio(parseFolio(text))).toBe(text);
  });

  it('a no-op save rewrites byte-identically (empty fixture)', () => {
    const text = serializeFolio(emptyFixture);
    expect(serializeFolio(parseFolio(text))).toBe(text);
  });

  it('persists per-column table widths natively (folio-only, no Markdown equivalent)', () => {
    const doc: FolioDocument = {
      ...emptyFixture,
      blocks: [
        {
          id: 't2a2b3c4d5',
          type: 'table',
          align: ['left', null],
          widths: [3, 1],
          rows: [
            [
              [{ kind: 'text', text: 'A', marks: {} }],
              [{ kind: 'text', text: 'B', marks: {} }]
            ],
            [
              [{ kind: 'text', text: '1', marks: {} }],
              [{ kind: 'text', text: '2', marks: {} }]
            ]
          ]
        }
      ]
    };
    const text = serializeFolio(doc);
    expect(text).toContain('"widths"');
    expect(parseFolio(text)).toEqual(doc);
    // widths sits between align and rows in the serialized key order.
    expect(text.indexOf('"align"')).toBeLessThan(text.indexOf('"widths"'));
    expect(text.indexOf('"widths"')).toBeLessThan(text.indexOf('"rows"'));
  });

  it('never invents a widths key for a width-free table (absent stays absent)', () => {
    // richFixture's table carries no widths; a round-trip must not add the key.
    expect(serializeFolio(richFixture)).not.toContain('"widths"');
  });

  it('persists the underline mark natively (no Markdown equivalent exists)', () => {
    const doc: FolioDocument = {
      ...emptyFixture,
      blocks: [
        {
          id: 'p1a2b3c4d5',
          type: 'paragraph',
          inline: [{ kind: 'text', text: 'noted', marks: { underline: true } }]
        }
      ]
    };
    const text = serializeFolio(doc);
    expect(text).toContain('"underline": true');
    expect(parseFolio(text)).toEqual(doc);
  });
});

describe('serializeFolio determinism (spec §9)', () => {
  const text = serializeFolio(richFixture);

  it('uses 2-space indent, LF, and a single trailing newline', () => {
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toContain('\r');
    expect(text).toContain('\n  "docId"');
  });

  it('orders the envelope keys schemaVersion, docId, docMeta, blocks', () => {
    expect(text.indexOf('"schemaVersion"')).toBeLessThan(text.indexOf('"docId"'));
    expect(text.indexOf('"docId"')).toBeLessThan(text.indexOf('"docMeta"'));
    expect(text.indexOf('"docMeta"')).toBeLessThan(text.indexOf('"blocks"'));
  });

  it('emits only set marks, never a false mark boolean', () => {
    // `checked: false` is legitimate task-item content, so we check the mark
    // booleans specifically, not the literal "false".
    for (const mark of ['em', 'strong', 'code', 'strikethrough']) {
      expect(text).not.toContain(`"${mark}": false`);
    }
    expect(text).toContain('"strong": true');
    expect(text).toContain('"em": true');
  });

  it('places marks last on an inline leaf (kind, then fields, then marks)', () => {
    // Serialize an isolated marked leaf so key positions are unambiguous.
    const one = serializeFolio({
      schemaVersion: 1,
      docId: 'x',
      docMeta: { title: null, createdAt: '' },
      blocks: [
        {
          id: 'p',
          type: 'paragraph',
          inline: [{ kind: 'text', text: 'hi', marks: { strong: true } }]
        }
      ]
    });
    expect(one.indexOf('"kind"')).toBeLessThan(one.indexOf('"text"'));
    expect(one.indexOf('"text"')).toBeLessThan(one.indexOf('"marks"'));
  });

  it('is stable across independent serializations of equal input', () => {
    const a = serializeFolio(richFixture);
    const b = serializeFolio(parseFolio(a));
    expect(a).toBe(b);
  });

  it('normalizes an out-of-canonical-order docMeta to title-then-createdAt', () => {
    const scrambled: FolioDocument = {
      schemaVersion: 1,
      docId: EMPTY_DOC_ID,
      // createdAt authored before title; the writer forces canonical order.
      docMeta: { createdAt: '2026-07-02T00:00:00.000Z', title: 'Late title' } as FolioDocument['docMeta'],
      blocks: []
    };
    const out = serializeFolio(scrambled);
    expect(out.indexOf('"title"')).toBeLessThan(out.indexOf('"createdAt"'));
  });
});
