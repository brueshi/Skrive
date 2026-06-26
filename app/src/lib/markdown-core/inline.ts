// Canonical inline serialization — substrate-independent. Owns every CommonMark
// inline edge case so neither serializer has to.
//
// The canonical inline path must produce Markdown that re-parses (via the same
// parseMarkdown) to a tree mdast-equal to what the source block represents. That
// is CommonMark escaping in full: backslash-escaping text that would re-parse as
// markup, line-start escaping of block openers (`> `, `# `, `1. `), code-span
// fences longer than any backtick run inside the span, link-destination and
// link-title quoting, and the attention (emphasis/strong) adjacency rules.
// Hand-rolling that means owning every CommonMark edge case forever, so instead
// the flat inline runs are rebuilt into a small mdast inline tree and serialized
// through remark-stringify — i.e. mdast-util-to-markdown, which has been hardened
// against exactly these cases for years.
//
// The currency is {@link InlineItem}: a flat run with its mark context, derived
// from whatever substrate (a ProseMirror node's children, or the block model's
// inline array). Each substrate owns its own flattening into InlineItem[]; the
// rebuild from there is shared.

import type { Heading, Paragraph, PhrasingContent, Root } from 'mdast';
import { unified } from 'unified';
import remarkStringify from 'remark-stringify';

// `*` emphasis/strong matches the canonical style this serializer emits.
const stringifier = unified().use(remarkStringify, { emphasis: '*', strong: '*' });

// Serialize a single mdast block. remark-stringify terminates the document with a
// newline; block joining is the caller's job, so strip it.
function mdastBlockToMarkdown(block: Heading | Paragraph): string {
  const out = String(stringifier.stringify({ type: 'root', children: [block] } as Root));
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

export type LinkRef = { href: string; title: string | null };

// A flat inline run: one leaf (text, code span, image, or hard break) plus the
// mark context it sits in. A substrate's inline content is flattened into these,
// coalescing adjacent text with the same context, before the nested mdast tree is
// rebuilt.
export type InlineItem = { em: boolean; strong: boolean; link: LinkRef | null } & (
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'image'; url: string; alt: string; title: string | null }
  | { kind: 'break' }
);

export function sameInlineContext(a: InlineItem, b: InlineItem): boolean {
  if (a.em !== b.em || a.strong !== b.strong) return false;
  if (a.link === null || b.link === null) return a.link === b.link;
  return a.link.href === b.link.href && a.link.title === b.link.title;
}

type Wrapper = 'em' | 'strong' | 'link';

// Outer-wrapper preference when the lookahead ties — i.e. a span where two or
// more marks are exactly coextensive. Mark order is normalized, so the original
// nesting of coextensive marks is unrecoverable; this order is chosen so the
// common written forms survive re-parse exactly: `***x***` parses em-outside-
// strong (so em must wrap first), and a fully-bold link is conventionally written
// `**[label](url)**` (strong before link). The minority forms (`**_x_**`,
// `[**label**](url)`) canonicalize to the majority nesting when dirtied —
// identical rendering, flipped tree.
const WRAPPER_PRIORITY: readonly Wrapper[] = ['em', 'strong', 'link'];

// The link-key separator: a NUL, which can never appear in a URL or a link title,
// so two genuinely different links never collapse to the same grouping key (a
// printable separator like a space could — a title may contain spaces).
const LINK_KEY_SEP = String.fromCharCode(0);

// A wrapper's grouping key at one run: null when the run does not carry the mark;
// links key on href+title so differently-targeted adjacent links never merge.
function wrapperKey(item: InlineItem, w: Wrapper): string | null {
  if (w === 'em') return item.em ? 'em' : null;
  if (w === 'strong') return item.strong ? 'strong' : null;
  if (!item.link) return null;
  return `${item.link.href}${LINK_KEY_SEP}${item.link.title ?? LINK_KEY_SEP}`;
}

function withoutWrapper(item: InlineItem, w: Wrapper): InlineItem {
  if (w === 'em') return { ...item, em: false };
  if (w === 'strong') return { ...item, strong: false };
  return { ...item, link: null };
}

function leafToMdast(item: InlineItem): PhrasingContent {
  switch (item.kind) {
    case 'code':
      return { type: 'inlineCode', value: item.text };
    case 'image':
      return { type: 'image', url: item.url, alt: item.alt, title: item.title };
    case 'break':
      return { type: 'break' };
    default:
      return { type: 'text', value: item.text };
  }
}

// Rebuild the nested mdast inline tree from the flat runs. Greedy with lookahead:
// at each run, open the wrapper whose identical key extends over the most
// following runs, so a mark spanning several differently-marked runs becomes ONE
// node containing them — `*a**b***` is em(a, strong(b)), not em(a) + strong(em(b)),
// and those parse differently. Outside the coextensive ties WRAPPER_PRIORITY
// arbitrates, this reconstruction is exact.
export function buildPhrasing(items: InlineItem[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (!item) break;
    let best: Wrapper | null = null;
    let bestLen = 0;
    for (const w of WRAPPER_PRIORITY) {
      const key = wrapperKey(item, w);
      if (key === null) continue;
      let j = i + 1;
      while (j < items.length) {
        const next = items[j];
        if (!next || wrapperKey(next, w) !== key) break;
        j++;
      }
      if (j - i > bestLen) {
        best = w;
        bestLen = j - i;
      }
    }
    if (best === null) {
      out.push(leafToMdast(item));
      i++;
      continue;
    }
    const chosen = best;
    const inner = buildPhrasing(items.slice(i, i + bestLen).map((it) => withoutWrapper(it, chosen)));
    if (chosen === 'em') out.push({ type: 'emphasis', children: inner });
    else if (chosen === 'strong') out.push({ type: 'strong', children: inner });
    else if (item.link) {
      out.push({ type: 'link', url: item.link.href, title: item.link.title, children: inner });
    }
    i += bestLen;
  }
  return out;
}

/** Flat inline runs -> canonical Markdown in paragraph context (line-start block
 *  openers like `> ` get escaped). Empty content yields the empty string. */
export function inlineItemsToParagraphMarkdown(items: InlineItem[]): string {
  const children = buildPhrasing(items);
  if (children.length === 0) return '';
  return mdastBlockToMarkdown({ type: 'paragraph', children });
}

/** Flat inline runs -> a canonical Markdown heading of the given level. The level
 *  is clamped to 1..6; the library owns heading-specific safety (a hard break,
 *  only reachable from a setext source, emits setext for depth 1-2 and collapses
 *  to a space for depth 3+, instead of splitting the block). */
export function inlineItemsToHeadingMarkdown(items: InlineItem[], level: number): string {
  const depth = Math.min(6, Math.max(1, Math.floor(level) || 1)) as Heading['depth'];
  const children = buildPhrasing(items);
  return mdastBlockToMarkdown({ type: 'heading', depth, children });
}
