// Which files Skrive can open, as a leaf module usable from the main thread.
//
// The project model owns the authoritative copies of these patterns, but it
// lives in the Worker and pulling it onto the main thread would drag the link
// graph along with it for the sake of four regexes. So the predicates live
// here, and main-thread callers (the OS-open resolver, the sidebar's document
// icon) share this one copy instead of each keeping their own.

/** Markdown — the format with a parsed body, links, and lint. */
export const MARKDOWN_EXT = /\.(md|markdown)$/i;
/** Skrive's native rich document. */
export const FOLIO_EXT = /\.folio$/i;
/** Plain text: raw edit, no Markdown interpretation. */
export const TEXT_EXT = /\.(txt|text)$/i;
/** HTML: read-only rendered viewer. Editing an `.html` is out of scope; the
 *  path forward is Convert to Skrive document. */
export const HTML_EXT = /\.(html|htm)$/i;

const OPENABLE_EXT = [MARKDOWN_EXT, FOLIO_EXT, TEXT_EXT, HTML_EXT];

/** Whether Skrive can open this path at all. Takes an absolute or a
 *  project-relative path — only the extension is consulted. */
export function isOpenableDoc(path: string): boolean {
  return OPENABLE_EXT.some((re) => re.test(path));
}
