// HTML export: `.folio` -> a standalone HTML document.
//
// The body comes from the *same* unified pipeline the preview uses
// (`renderMarkdown`), so exported HTML matches what the writer sees. That
// pipeline emits a body fragment; a file export needs a complete document, so we
// wrap it in a minimal, self-contained shell — charset, a title, and a small
// readable stylesheet — with no external assets, so the file opens cleanly
// anywhere and can be shared as-is.

import { renderMarkdown } from '../preview/markdown';
import type { FolioDocument } from '../folio/types';
import { folioToMarkdown } from './markdown';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A restrained, system-font stylesheet. Just enough to make an exported document
// pleasant to open in a browser; deliberately not a theme.
const STYLE = `
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
    max-width: 44rem;
    margin: 3rem auto;
    padding: 0 1.25rem;
  }
  pre {
    overflow-x: auto;
    padding: 0.85rem 1rem;
    border-radius: 6px;
    background: rgba(127, 127, 127, 0.12);
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  blockquote {
    margin-inline: 0;
    padding-inline-start: 1rem;
    border-inline-start: 3px solid rgba(127, 127, 127, 0.4);
    color: rgba(127, 127, 127, 0.95);
  }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(127, 127, 127, 0.4); padding: 0.4rem 0.7rem; }
  img { max-width: 100%; }
`;

/** Export a `.folio` document to a standalone HTML document. `title` overrides the
 *  document's own `docMeta.title` (the UI passes the clean filename). */
export function folioToHtml(folio: FolioDocument, options?: { title?: string }): string {
  const body = renderMarkdown(folioToMarkdown(folio));
  const title = options?.title ?? folio.docMeta.title ?? 'Untitled';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}
