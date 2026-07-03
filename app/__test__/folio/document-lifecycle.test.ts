// The `.folio` document lifecycle the store wires up (SKR-196 PR3): a document is
// created (mint), opened (parse -> model), and saved (model -> bytes) through the
// real folio save path. The load-bearing invariant is that open -> save with no
// edit is byte-identical, which is what keeps a tab's `diskHash` stable and stops
// a no-op save from false-firing external-change detection.

import { describe, expect, it } from 'vitest';
import { buildFolioPayload } from '../../src/stores/save/folio-save';
import {
  DOC_ID_RE,
  folioToModel,
  generateDocId,
  parseFolio,
  serializeFolio,
  type FolioDocument
} from '../../src/lib/folio';
import { richFixture } from './fixture';

describe('.folio document lifecycle (create -> open -> save)', () => {
  it('mints a valid empty document and a no-op save is byte-identical', () => {
    // The exact shape createFolioDocument writes for a fresh document.
    const doc: FolioDocument = {
      schemaVersion: 1,
      docId: generateDocId(),
      docMeta: { title: null, createdAt: '2026-07-03T00:00:00.000Z' },
      blocks: []
    };
    expect(DOC_ID_RE.test(doc.docId)).toBe(true);

    const onDisk = serializeFolio(doc);
    // open: bytes -> model; save with no edit: model -> bytes through the real
    // save path (buildFolioPayload), which must reproduce the bytes exactly.
    const model = folioToModel(parseFolio(onDisk));
    const resaved = buildFolioPayload({ model, docId: doc.docId, docMeta: doc.docMeta });
    expect(resaved).toBe(onDisk);
  });

  it('opens and re-saves a rich document byte-identically', () => {
    const onDisk = serializeFolio(richFixture);
    const opened = parseFolio(onDisk);
    const model = folioToModel(opened);
    const resaved = buildFolioPayload({
      model,
      docId: opened.docId,
      docMeta: opened.docMeta
    });
    expect(resaved).toBe(onDisk);
  });
});
