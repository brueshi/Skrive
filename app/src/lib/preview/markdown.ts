// Markdown pipeline for the preview pane. A unified remark -> rehype
// pipeline: remark-parse -> remark-gfm -> remark-rehype -> rehype-stringify,
// with two small local hast plugins (heading ids, image-src resolution).
//
// Why unified and not `marked`: the projection (rich) surface parses with
// `mdast-util-from-markdown` (micromark). remark-parse is the same micromark
// tokenizer, so the preview and the rich surface now agree on what a given
// piece of Markdown *means* — one structural authority, no second opinion.
// See planning/projection-editor-master-plan.md (§9.3).
//
// Frontmatter handling: the preview always strips a leading `---...---`
// block before rendering. Files opened from disk (Phase 6) will arrive
// with frontmatter already stripped by the loader; this strip handles the
// case where the user has typed or pasted YAML directly into the editor.
//
// Sanitization note: the content we render comes exclusively from files
// the user has opened on their own disk. We treat it as trusted input and
// do not strip HTML — `allowDangerousHtml` passes raw HTML through verbatim,
// matching the old `marked` behavior (Markdown `![]()` images are resolved;
// raw `<img>`/HTML passes through untouched). If we ever render Markdown
// from the network, that caller must sanitize before handing it here.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Nodes as HastNodes, Root as HastRoot } from 'hast';
import { SlugDeduper } from './slugify';

export type ImageContext = {
  projectRoot: string;
  filePath: string | null;
};

export type ImageResolver = (rawUrl: string, ctx: ImageContext) => string;

const identityResolver: ImageResolver = (rawUrl) => rawUrl;

// Per-render state. Reset at the top of every `renderMarkdown` call; the
// plugins below read these via closure. A fresh deduper per render scopes
// the heading-id counter to one document, exactly as before.
let currentContext: ImageContext = { projectRoot: '', filePath: null };
let currentResolver: ImageResolver = identityResolver;
let currentDeduper = new SlugDeduper();

/** Rendered text content of a hast node, concatenated depth-first. Used to
 *  slug a heading from what the reader sees — so a heading containing a link
 *  slugs from the link's label, not its URL, and inline markup is ignored. */
function hastText(node: HastNodes): string {
  if (node.type === 'text') return node.value;
  if ('children' in node) {
    let out = '';
    for (const child of node.children) out += hastText(child);
    return out;
  }
  return '';
}

/** Assign a de-duplicated slug `id` to each heading, reusing the same
 *  slugify + deduper the app shipped with `marked` so anchors are
 *  byte-identical. A heading whose text slugs to empty (punctuation only)
 *  gets no id, matching the prior behavior. The DOM-driven outline rail
 *  reads these ids, so this parity is load-bearing. */
function rehypeHeadingIds() {
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node) => {
      if (!/^h[1-6]$/.test(node.tagName)) return;
      const slug = currentDeduper.next(hastText(node));
      if (slug) node.properties = { ...node.properties, id: slug };
    });
  };
}

/** Rewrite Markdown image sources through the active resolver (project-aware
 *  asset URLs in a loaded project; identity otherwise). Only touches `<img>`
 *  elements produced from Markdown image syntax — raw HTML images pass
 *  through untouched, as they did under `marked`. */
function rehypeResolveImages() {
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'img') return;
      const src = node.properties?.src;
      if (typeof src === 'string') {
        node.properties = {
          ...node.properties,
          src: currentResolver(src, currentContext)
        };
      }
    });
  };
}

// Built once and reused. The plugins are stateless closures over the
// per-render module state above, so a single processor is safe and avoids
// per-call construction cost on the debounced preview path.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeHeadingIds)
  .use(rehypeResolveImages)
  .use(rehypeStringify, { allowDangerousHtml: true });

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
  currentContext = options?.context ?? { projectRoot: '', filePath: null };
  currentResolver = options?.resolver ?? identityResolver;
  currentDeduper = new SlugDeduper();
  try {
    return String(processor.processSync(stripLeadingFrontmatter(body)));
  } finally {
    currentContext = { projectRoot: '', filePath: null };
    currentResolver = identityResolver;
  }
}
