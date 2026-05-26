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
  return String(processor.processSync(html)).trim();
}
