// Import pipeline (SKR-200): open formats -> the editing block model, the inbound
// half of the portability promise. Paired with the export pipeline
// (`../export`), and the raw material for the explicit `.md` -> `.folio` upgrade.
//
// Honest and lossy-by-design, like export: a construct the block model can't
// represent richly parses to a `frozen_block`, which `modelToFolio` resolves to a
// paragraph carrying the raw text. Nothing is silently dropped, and the source
// file is never mutated — the conversion always mints a *new* `.folio`.
//
// Scope: text sources already in the project (there is no host file-open dialog,
// so external files aren't reachable). Markdown, HTML, and plain text convert;
// RTF import would need a full RTF parser and is deferred.

import { parseDocument } from '../blockmodel';
import type { Document } from '../blockmodel/types';
import { htmlToMarkdown } from '../clipboard/htmlToMarkdown';
import { parseFrontmatter } from '../frontmatter';

export type ImportKind = 'markdown' | 'html' | 'text';

const KIND_BY_EXT: Record<string, ImportKind> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  txt: 'text',
  text: 'text'
};

/** The import kind for a path, or null when it isn't a convertible source.
 *  `.folio` (already native), binaries, and unknown extensions all return null,
 *  so this doubles as the "offer "Convert to Skrive document"?" predicate. */
export function importKind(path: string): ImportKind | null {
  const slash = path.lastIndexOf('/');
  const leaf = slash === -1 ? path : path.slice(slash + 1);
  const dot = leaf.lastIndexOf('.');
  if (dot <= 0) return null; // no extension, or a dotfile with no stem
  return KIND_BY_EXT[leaf.slice(dot + 1).toLowerCase()] ?? null;
}

export interface ImportedSource {
  model: Document;
  /** A title lifted from the source where it carries one (Markdown frontmatter
   *  `title:`), else null — the new `.folio` mints its own identity regardless. */
  title: string | null;
}

/** Convert raw source bytes of a given kind into the editing block model plus a
 *  best-effort title. Pure and substrate-independent (no filesystem, no DOM —
 *  the HTML path uses the same rehype pipeline as clipboard paste). */
export function sourceToModel(raw: string, kind: ImportKind): ImportedSource {
  switch (kind) {
    case 'markdown': {
      const { body, frontmatter } = parseFrontmatter(raw);
      const fmTitle = frontmatter['title'];
      const title = typeof fmTitle === 'string' && fmTitle.trim() !== '' ? fmTitle.trim() : null;
      return { model: parseDocument(body), title };
    }
    case 'html':
      return { model: parseDocument(htmlToMarkdown(raw)), title: null };
    case 'text':
      // Plain text parses as Markdown-ish: bare prose becomes paragraphs, and any
      // incidental Markdown syntax is honored. Lossless for prose, best-effort
      // otherwise.
      return { model: parseDocument(raw), title: null };
  }
}
