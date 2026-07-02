// Rich-text editors leak structural noise into the HTML they put on the
// clipboard. The worst offenders are Google Docs and Microsoft Word, which
// carry emphasis in two mismatched ways:
//
//   - They wrap runs of text in <b>/<i> and then *cancel* the formatting with
//     an inline style (Google Docs' outer `<b style="font-weight:normal">`
//     guid wrapper). The hast -> mdast step reads tag semantics only, so
//     without a pass this would turn an entire pasted document bold.
//   - They express *real* emphasis purely as inline style on a <span>
//     (`font-weight:700`, `font-style:italic`) with no <b>/<i> tag at all.
//     The hast -> mdast step ignores style, so without a pass every bold and
//     italic run pastes as plain text — the marks vanish entirely (SKR-161).
//
// The two are inverse problems, so this plugin does both on the hast tree
// (after parsing, before the mdast conversion): it UNWRAPS tags whose style
// cancels their formatting, and PROMOTES styled runs to real <strong>/<em>.
//
// Unwrap (replace the element with its children):
//   - <b>/<i> whose inline style cancels the formatting (the fake-emphasis
//     wrappers above);
//   - <u>, which has no faithful Markdown form. hast-util-to-mdast maps it to
//     emphasis by default; per the "drop unrepresentable formatting" decision
//     we drop the underline rather than silently reinterpret it as italic.
//   - <b>/<strong> that wraps the entire text of a heading. Sites that bold
//     their headings (e.g. anthropic.com) would otherwise yield `## **Title**`;
//     the heading already carries the emphasis, so the wrapper is redundant.
//     Partial bold inside a heading is left alone — that is real emphasis.
//
// Promote (wrap the element's children in <strong>/<em>):
//   - any element that directly holds a text run and whose own style declares
//     bold (`font-weight:700`/`bold`) or italic. Restricting to a direct text
//     child respects the cascade: Google Docs sets font-weight on the <li> AND
//     on the inner spans, and an inner span carrying `font-weight:400` is the
//     authoritative one for its text — promoting only text-bearing elements
//     lets that explicit "normal" win instead of bolding the whole item.
//
// It is intentionally narrow: a new source-specific quirk gets its own named
// rule here rather than a catch-all that risks dropping real formatting.

import { visit } from 'unist-util-visit';
import type { Element, ElementContent, Root } from 'hast';

// Anchored to the property-name boundary (start of string, or after a `;`/space)
// so `mso-bidi-font-weight:normal` — a style Word attaches to genuinely bold
// text — is NOT read as a cancel and does not destroy real Word bold (SKR-161).
const CANCELS_BOLD = /(?:^|[;\s])font-weight\s*:\s*(?:normal|400)\b/i;
const CANCELS_ITALIC = /(?:^|[;\s])font-style\s*:\s*normal\b/i;
// Real emphasis carried as inline style: bold is 600-900 or the `bold` keyword;
// italic is the `italic` keyword. Same boundary anchoring so an `mso-bidi-`
// prefixed property never counts.
const APPLIES_BOLD = /(?:^|[;\s])font-weight\s*:\s*(?:bold|[6-9]00)\b/i;
const APPLIES_ITALIC = /(?:^|[;\s])font-style\s*:\s*italic\b/i;
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const EMPHASIS_TAGS = new Set(['b', 'strong', 'i', 'em']);

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

// A styled text run gets its marks made real. Only elements that directly hold
// text are promoted (see the cascade note above); the resulting <strong>/<em>
// carry no style, so re-visiting them is a no-op. Nesting order (strong outside
// em) is irrelevant to the mdast the stringifier emits.
function promoteStyledEmphasis(node: Element, parent: Element): void {
  // <b>/<strong>/<i>/<em> already carry emphasis by tag; hast-util-to-mdast maps
  // them natively, so promoting them too would double-wrap (`****text****`). This
  // pass exists for the tagless case — style on a <span>/<p>/<li>.
  if (EMPHASIS_TAGS.has(node.tagName)) return;
  const style = inlineStyle(node);
  if (style === '') return;
  let bold = APPLIES_BOLD.test(style);
  const italic = APPLIES_ITALIC.test(style);
  if (!bold && !italic) return;
  if (!node.children.some((c) => c.type === 'text' && c.value.trim() !== '')) return;
  // A heading already renders bold, so promoting a bold run that fills the whole
  // heading would yield a redundant `## **Title**` — the same case the
  // wrapsWholeHeading unwrap guards for <strong>. Italic in a heading is real
  // emphasis and is kept.
  if (bold && HEADINGS.has(parent.tagName) && wrapsWholeParent(node, parent)) bold = false;
  if (!bold && !italic) return;
  let inner: ElementContent[] = node.children;
  if (italic) inner = [{ type: 'element', tagName: 'em', properties: {}, children: inner }];
  if (bold) inner = [{ type: 'element', tagName: 'strong', properties: {}, children: inner }];
  node.children = inner;
}

// True when `node` is the only meaningful child of `parent` (whitespace-only
// text siblings don't count) — i.e. the run spans the whole parent.
function wrapsWholeParent(node: Element, parent: Element): boolean {
  return parent.children.every(
    (child) => child === node || (child.type === 'text' && child.value.trim() === '')
  );
}

// True when `node` is the heading's only meaningful child — i.e. the bold spans
// the whole heading. Whitespace-only text siblings (Notion/WebKit pad with
// them) don't count as content, so `<h2> <strong>X</strong> </h2>` still matches.
function wrapsWholeHeading(node: Element, parent: Element): boolean {
  if (!HEADINGS.has(parent.tagName)) return false;
  if (node.tagName !== 'b' && node.tagName !== 'strong') return false;
  return wrapsWholeParent(node, parent);
}

export function rehypeCleanRichText() {
  return (tree: Root): void => {
    visit(tree, 'element', (node, index, parent) => {
      if (parent == null || index == null) return;
      const unwrap =
        shouldUnwrap(node) ||
        (parent.type === 'element' && wrapsWholeHeading(node, parent));
      if (unwrap) {
        // Replace the unwrapped element with its children, then re-visit from
        // the same index so the now-exposed children are themselves cleaned
        // (Google Docs nests these wrappers several deep).
        parent.children.splice(index, 1, ...node.children);
        return index;
      }
      // Not cancelled — the inverse case: a run whose emphasis lives only in its
      // inline style becomes a real <strong>/<em> so the mdast step keeps it.
      if (parent.type === 'element') promoteStyledEmphasis(node, parent);
    });
  };
}
