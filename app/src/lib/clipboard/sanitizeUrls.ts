// Strip URLs the trust model doesn't permit out of clipboard HTML, before the
// hast -> mdast step turns them into model nodes (SKR-187 / F29).
//
// This runs at INGESTION, which is where external input crosses into the
// document: once a `javascript:` URL is a link node in the model it gets saved
// to disk, exported to HTML by the export pipeline, and carried anywhere the
// file goes. Stopping it here means it never becomes the document's problem.
//
// Ingestion is not the only guard — `render.ts` refuses to emit a dangerous
// `href` too, which covers the URLs that never pass through this pass (a
// markdown link arriving as `text/plain`, a URL typed into the link editor, a
// file authored elsewhere). Two independent checks, on purpose.
//
// Treatment: an unsafe `<a>` is UNWRAPPED to its text, and an unsafe `<img>`
// collapses to its alt text. The content the writer meant to paste survives; the
// executable part does not. Blanking the attribute instead would round-trip a
// visibly broken `[click](<>)` into the file, which reads as corruption.

import { visit } from 'unist-util-visit';
import type { Element, Root } from 'hast';
import { isSafeUrl } from '../security/urls';

function attr(node: Element, name: string): string | null {
  const value = node.properties?.[name];
  return typeof value === 'string' ? value : null;
}

export function rehypeSanitizeUrls() {
  return (tree: Root): void => {
    visit(tree, 'element', (node, index, parent) => {
      if (parent == null || index == null) return;

      if (node.tagName === 'a') {
        const href = attr(node, 'href');
        // A bare `<a>` with no href is already inert; leave its text alone.
        if (href == null || isSafeUrl(href)) return;
        parent.children.splice(index, 1, ...node.children);
        return index; // re-visit the exposed children in place
      }

      if (node.tagName === 'img') {
        const src = attr(node, 'src');
        if (src != null && isSafeUrl(src)) return;
        const alt = attr(node, 'alt') ?? '';
        parent.children.splice(index, 1, ...(alt === '' ? [] : [{ type: 'text' as const, value: alt }]));
        return index;
      }
    });
  };
}
