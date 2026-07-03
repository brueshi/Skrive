// Plain-text export: `.folio` -> bare prose. Reuses `documentToPlainText`, which
// drops Markdown syntax and keeps only readable text (bullet markers gone,
// ordered numbers kept, tables flattened to tab-separated rows). Lossy by
// design — plain text carries no formatting — and honest about it.

import { documentToPlainText } from '../blockmodel/plaintext';
import { folioToModel } from '../folio/convert';
import type { FolioDocument } from '../folio/types';

/** Export a `.folio` document to plain text. */
export function folioToPlainText(folio: FolioDocument): string {
  return documentToPlainText(folioToModel(folio));
}
