// The `.folio` rich save path (SKR-196). Serializes the canonical block model to
// the native format via the folio library (SKR-195). Deterministic by design: an
// unchanged document serializes byte-identically, so the tab's `diskHash` stays
// stable and external-change detection never false-fires on a no-op save.
//
// It stamps NO time field — `createdAt` is immutable (minted once at creation) and
// there is no `updatedAt` in the file body (folio schema §4/§6); a per-save time
// stamp would break the byte-determinism guarantee.

import { modelToFolio, serializeFolio, type FolioMeta } from '../../lib/folio';
import type { Document } from '../../lib/blockmodel';

/** The tab shape a folio save needs: the model plus the document identity carried
 *  alongside it (read from the file on open, minted once on create). */
export type FolioSaveTab = { model: Document; docId: string; docMeta: FolioMeta };

export function buildFolioPayload(tab: FolioSaveTab): string {
  return serializeFolio(modelToFolio(tab.model, { docId: tab.docId, docMeta: tab.docMeta }));
}
