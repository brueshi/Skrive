// Markdown pipeline for the preview pane. Uses `marked` with GFM enabled.
//
// Frontmatter handling: the preview always strips a leading `---...---`
// block before rendering. Files opened from disk (Phase 6) will arrive
// with frontmatter already stripped by the loader; this strip handles the
// case where the user has typed or pasted YAML directly into the editor.
//
// Sanitization note: the content we render comes exclusively from files
// the user has opened on their own disk. We treat it as trusted input and
// do not strip HTML. If we ever render Markdown from the network (e.g.
// importers pulling from Obsidian Publish), that caller must sanitize
// before handing content to this module.
//
// Phase 2 image resolver is identity (matches the editor's image
// decoration default). Phase 6 swaps both for a project-aware resolver.

import { marked } from 'marked';
import type { Tokens } from 'marked';

export type ImageContext = {
  projectRoot: string;
  filePath: string | null;
};

export type ImageResolver = (rawUrl: string, ctx: ImageContext) => string;

const identityResolver: ImageResolver = (rawUrl) => rawUrl;

marked.setOptions({
  gfm: true,
  breaks: false
});

let currentContext: ImageContext = { projectRoot: '', filePath: null };
let currentResolver: ImageResolver = identityResolver;

marked.use({
  renderer: {
    image({ href, title, text }: Tokens.Image): string {
      const resolved = currentResolver(href, currentContext);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<img src="${escapeAttr(resolved)}" alt="${escapeAttr(text)}"${titleAttr}>`;
    }
  }
});

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Strip a leading YAML frontmatter block from a body string.
 *
 *   - The opening fence must be `---` at byte zero followed by `\n` or `\r\n`.
 *   - The closing fence is the first line whose trimmed content is exactly
 *     `---` or `...`.
 *   - An unterminated opening fence is *not* stripped — we'd rather render
 *     the raw `---` than silently eat the whole document.
 */
export function stripLeadingFrontmatter(source: string): string {
  let prefixLen: number;
  if (source.startsWith('---\n')) {
    prefixLen = 4;
  } else if (source.startsWith('---\r\n')) {
    prefixLen = 5;
  } else {
    return source;
  }

  const rest = source.slice(prefixLen);
  const lines = rest.split('\n');
  let charsConsumed = 0;
  for (const line of lines) {
    charsConsumed += line.length + 1;
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed === '---' || trimmed === '...') {
      return rest.slice(charsConsumed);
    }
  }

  return source;
}

export function renderMarkdown(
  body: string,
  options?: { context?: ImageContext; resolver?: ImageResolver }
): string {
  currentContext = options?.context ?? { projectRoot: '', filePath: '' };
  currentResolver = options?.resolver ?? identityResolver;
  try {
    const stripped = stripLeadingFrontmatter(body);
    return marked.parse(stripped) as string;
  } finally {
    currentContext = { projectRoot: '', filePath: null };
    currentResolver = identityResolver;
  }
}
