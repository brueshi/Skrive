// Project-aware image resolver shared by the preview and the editor's inline
// image widget. Markdown image URLs are relative to the source document; this
// rewrites a local one to a `skrive-asset://asset/<project-relative-path>` URL
// that the main-process custom protocol serves from the project root (see
// shell/src/main/asset-protocol.ts).
//
// External and already-absolute URLs (http, https, data, mailto, the
// skrive-asset scheme itself, protocol-relative `//host`) pass through
// untouched. The resolver only needs the document's project-relative path from
// the context; the project root lives in trusted main state.

import type { ImageResolver } from './markdown';

const SCHEME = 'skrive-asset';

function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
}

function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i >= 0 ? relPath.slice(0, i) : '';
}

export const skriveAssetResolver: ImageResolver = (rawUrl, ctx) => {
  if (rawUrl === '' || isAbsoluteUrl(rawUrl)) return rawUrl;

  // Compose the image's project-relative path from the document's directory,
  // normalising `.`/`..` and decoding each segment to its on-disk form (the
  // protocol handler re-decodes, so we re-encode below).
  const sourceDir = dirOf(ctx.filePath ?? '');
  const combined = sourceDir ? `${sourceDir}/${rawUrl}` : rawUrl;
  const segments: string[] = [];
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    try {
      segments.push(decodeURIComponent(seg));
    } catch {
      segments.push(seg);
    }
  }
  if (segments.length === 0) return rawUrl;

  return `${SCHEME}://asset/${segments.map(encodeURIComponent).join('/')}`;
};
