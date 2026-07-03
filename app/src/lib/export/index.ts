// Export pipeline (SKR-199): `.folio` -> open formats. Honest, lossy-by-design
// export — faithful where the target allows, degraded where it can't — NOT a
// byte-round-trip contract. This is the "you can always leave with everything"
// half of the portability promise (planning/dual-mode-editor-decision.md).
//
// Each format is a pure `FolioDocument -> string` function, unit-testable off the
// schema §10 fixture and decoupled from any UI or host concern. The registry
// below is what the sidebar "Export as ▸" menu and the command palette iterate.

import type { FolioDocument } from '../folio/types';
import { folioToMarkdown } from './markdown';
import { folioToHtml } from './html';
import { folioToPlainText } from './txt';
import { folioToRtf } from './rtf';

export { folioToMarkdown } from './markdown';
export { folioToHtml } from './html';
export { folioToPlainText } from './txt';
export { folioToRtf } from './rtf';
export { exportTargetPath } from './paths';

export type ExportFormatId = 'markdown' | 'html' | 'txt' | 'rtf';

export interface ExportFormat {
  id: ExportFormatId;
  /** Menu label. */
  label: string;
  /** File extension, without the leading dot. */
  extension: string;
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: 'markdown', label: 'Markdown', extension: 'md' },
  { id: 'html', label: 'HTML', extension: 'html' },
  { id: 'txt', label: 'Plain text', extension: 'txt' },
  { id: 'rtf', label: 'Rich text (RTF)', extension: 'rtf' }
];

/** Serialize a `.folio` document to the given format. `title` (when the target
 *  supports one — HTML) defaults to the clean document name the caller passes. */
export function exportFolio(
  folio: FolioDocument,
  format: ExportFormatId,
  options?: { title?: string }
): string {
  switch (format) {
    case 'markdown':
      return folioToMarkdown(folio);
    case 'html':
      return folioToHtml(folio, options);
    case 'txt':
      return folioToPlainText(folio);
    case 'rtf':
      return folioToRtf(folio);
  }
}
