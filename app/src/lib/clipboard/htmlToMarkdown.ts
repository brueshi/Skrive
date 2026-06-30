// Converts clipboard HTML into clean, canonical Markdown for paste-in.
//
// The clipboard usually carries a `text/html` representation alongside
// `text/plain`. This module takes that HTML and produces Markdown that matches
// Skrive's own conventions, so pasted content reads as if it had been written
// here rather than carried in from a web page or word processor.
//
// Pipeline (every stage is synchronous, so the paste handler can run it inline
// inside the DOM event without an async gap):
//
//   rehype-parse        HTML string -> hast   fragment mode: clipboard HTML is
//                                             a fragment, not a full document
//   rehypeCleanRichText hast -> hast          unwrap source-specific cruft
//   rehype-remark       hast -> mdast         styling Markdown can't represent
//                                             (colour, underline, font) is
//                                             dropped here by design
//   remark-gfm          (stringify support)   tables, strikethrough and task
//                                             lists survive the conversion
//   remark-stringify    mdast -> Markdown     pinned to the house style below
//
// House style: because nothing else in the app serialises Markdown yet, these
// options are the de-facto Skrive emit conventions — ATX headings, `-`
// bullets, `*`/`**` for emphasis/strong, fenced code blocks, `---` thematic
// breaks. Keep them in sync wherever we emit Markdown in future.

import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { rehypeCleanRichText } from './cleanHtml';

// Notion copies a callout block as an `<aside>…</aside>` wrapper, but *escaped*
// (`&lt;aside&gt;`), so it survives the HTML pipeline as literal `<aside>` /
// `</aside>` text lines rather than an element the converter could map. The
// faithful Skrive equivalent of a callout is a blockquote, so fold the marked
// region into one. Narrow by design: only a matched open/close pair on their own
// lines is converted, so prose that merely mentions `<aside>` is left untouched.
const ASIDE_OPEN = /^\\?<aside>\\?\s*$/;
const ASIDE_CLOSE = /^\\?<\/aside>\s*$/;

function convertNotionCallouts(md: string): string {
  if (!ASIDE_OPEN.test(md) && !/\n\\?<aside>/.test(md)) return md;
  const lines = md.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ASIDE_OPEN.test(lines[i]!)) {
      out.push(lines[i]!);
      continue;
    }
    let close = i + 1;
    while (close < lines.length && !ASIDE_CLOSE.test(lines[close]!)) close++;
    if (close >= lines.length) {
      // No closing marker — not a callout; leave the line as-is.
      out.push(lines[i]!);
      continue;
    }
    const inner = lines.slice(i + 1, close);
    while (inner.length && inner[0]!.trim() === '') inner.shift();
    while (inner.length && inner[inner.length - 1]!.trim() === '') inner.pop();
    if (out.length && out[out.length - 1]!.trim() !== '') out.push('');
    out.push(...inner.map((l) => (l.trim() === '' ? '>' : `> ${l}`)));
    i = close; // skip the closing marker
  }
  return out.join('\n');
}

const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeCleanRichText)
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '*',
    strong: '*',
    fence: '`',
    fences: true,
    rule: '-',
    listItemIndent: 'one',
    incrementListMarker: true
  })
  .freeze();

/**
 * Convert an HTML fragment (as found on the clipboard under `text/html`) to
 * canonical Markdown. Output is trimmed of leading and trailing blank lines so
 * it inserts cleanly at the cursor. Empty or whitespace-only input yields an
 * empty string.
 */
export function htmlToMarkdown(html: string): string {
  if (html.trim() === '') return '';
  return convertNotionCallouts(String(processor.processSync(html)).trim());
}

/**
 * Decide what a paste carrying `html` should insert. Returns the converted
 * Markdown, or null when there's nothing worth converting — blank HTML, or a
 * conversion that yields nothing (e.g. a bare `<meta>` prefix). On null the
 * caller defers to the editor's default plain-text paste, so text that arrived
 * without a rich representation lands verbatim instead of being round-tripped.
 */
export function markdownForPaste(html: string): string | null {
  if (html.trim() === '') return null;
  const md = htmlToMarkdown(html);
  return md === '' ? null : md;
}
