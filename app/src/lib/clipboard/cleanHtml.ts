// Rich-text editors leak structural noise into the HTML they put on the
// clipboard. The worst offenders are Google Docs and Microsoft Word, which
// wrap runs of text in <b>/<i> elements and then *cancel* the formatting with
// an inline style (`font-weight:normal`, `font-style:normal`). The
// hast -> mdast step only reads tag semantics, so without this pass it would
// turn an entire pasted document into bold or italic.
//
// This plugin runs on the hast tree (after parsing, before the mdast
// conversion) and unwraps elements that would otherwise mis-convert,
// replacing each with its children:
//
//   - <b>/<i> whose inline style cancels the formatting (the fake-emphasis
//     wrappers above);
//   - <u>, which has no faithful Markdown form. hast-util-to-mdast maps it to
//     emphasis by default; per the "drop unrepresentable formatting" decision
//     we drop the underline rather than silently reinterpret it as italic.
//
// It is intentionally narrow: a new source-specific quirk gets its own named
// rule here rather than a catch-all that risks dropping real formatting.

import { visit } from 'unist-util-visit';
import type { Element, Root } from 'hast';

const CANCELS_BOLD = /font-weight\s*:\s*(?:normal|400)\b/i;
const CANCELS_ITALIC = /font-style\s*:\s*normal\b/i;

function inlineStyle(node: Element): string {
  const style = node.properties?.style;
  return typeof style === 'string' ? style : '';
}

function shouldUnwrap(node: Element): boolean {
  const tag = node.tagName;
  if (tag === 'u') return true;
  const style = inlineStyle(node);
  if (style === '') return false;
  if ((tag === 'b' || tag === 'strong') && CANCELS_BOLD.test(style)) return true;
  if ((tag === 'i' || tag === 'em') && CANCELS_ITALIC.test(style)) return true;
  return false;
}

export function rehypeCleanRichText() {
  return (tree: Root): void => {
    visit(tree, 'element', (node, index, parent) => {
      if (parent == null || index == null) return;
      if (!shouldUnwrap(node)) return;
      // Replace the unwrapped element with its children, then re-visit from
      // the same index so the now-exposed children are themselves cleaned
      // (Google Docs nests these wrappers several deep).
      parent.children.splice(index, 1, ...node.children);
      return index;
    });
  };
}
