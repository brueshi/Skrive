// The single mdast parser for the projection bridge. Both parse (Markdown -> PM)
// and serialize (the idempotence guard's semantic-equality check) MUST parse
// through this same configuration, or the two would disagree about what a string
// means and the guard would mis-fire.
//
// GFM is enabled for *tables only* — not the full GFM umbrella. Tables are a
// modeled construct (Stage 2.5d); strikethrough, task lists, and autolinks are
// deliberately left as plain CommonMark text so they stay frozen rather than
// silently losing their syntax when an edited block re-serializes. Widen this
// only when those constructs are actually modeled.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import type { Root } from 'mdast';

// Constructed once and reused — the extension factories return stateless config
// that fromMarkdown only reads, so rebuilding them per parse was pure allocation
// on a hot path (the serialize idempotence guard parses on every snapshot).
const extensions = [gfmTable()];
const mdastExtensions = [gfmTableFromMarkdown()];

export function parseMarkdown(md: string): Root {
  return fromMarkdown(md, { extensions, mdastExtensions }) as Root;
}
