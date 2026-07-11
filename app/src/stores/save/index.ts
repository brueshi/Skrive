// Save-path routing (SKR-196). One dispatcher decides, by the tab's mode, which
// disjoint builder runs — the Markdown text->text path or the folio model->native
// path. This is the ONLY place the two paths meet; each builder lives in its own
// module with its own imports and its own tab type, so the Markdown serializer is
// unreachable from a folio save and no serializer at all is reachable from a
// Markdown save (see markdown-save.ts).

import { buildMarkdownPayload, type MarkdownSaveTab } from './markdown-save';
import { buildFolioPayload } from './folio-save';
import { buildTextPayload } from './text-save';
import type { EditorMode } from './file-mode';
import type { Document } from '../../lib/blockmodel';
import type { FolioMeta } from '../../lib/folio';

export { fileMode, type EditorMode } from './file-mode';
export { type MarkdownSaveTab } from './markdown-save';
export { type FolioSaveTab } from './folio-save';
export { type TextSaveTab } from './text-save';

/** The fields the dispatcher reads off a tab. The store's full `Tab` satisfies
 *  this structurally; `model`/`docId`/`docMeta` are present only on rich tabs. */
export type SaveTab = MarkdownSaveTab & {
  mode: EditorMode;
  model?: Document;
  docId?: string;
  docMeta?: FolioMeta;
};

/**
 * Build the on-disk bytes for a tab, routed by mode. A markdown tab goes to the
 * text->text path; a rich (`.folio`) tab serializes its model to the native
 * format; a plain-text (`.txt`) tab writes its body verbatim. Mutates a markdown
 * tab's frontmatter/body via absorption (callers pass a clone).
 */
export function buildSavePayload(tab: SaveTab): string {
  if (tab.mode === 'view') {
    // Read-only viewer (`.html`, SKR-205). Its surface never emits an edit, so a
    // view tab never goes dirty and this is unreachable in practice; the throw is
    // a defensive invariant guaranteeing no save path can persist a viewed file.
    throw new Error('Cannot save a read-only (view) tab.');
  }
  if (tab.mode === 'rich') {
    // A rich doc always carries these once opened (openDoc sets them); the guard
    // is a defensive invariant, not an expected branch.
    if (!tab.model || !tab.docId || !tab.docMeta) {
      throw new Error('Cannot save a rich (.folio) tab without a model, docId, and docMeta.');
    }
    return buildFolioPayload({ model: tab.model, docId: tab.docId, docMeta: tab.docMeta });
  }
  if (tab.mode === 'text') {
    return buildTextPayload(tab);
  }
  return buildMarkdownPayload(tab);
}
