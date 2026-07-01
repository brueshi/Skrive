// The single mdast parser shared by every Markdown consumer (the projection
// bridge today, the block model under the canonical inversion). Parse and the
// idempotence guard's semantic-equality check MUST go through this same
// configuration, or the two would disagree about what a string means and the
// guard would mis-fire.
//
// GFM is enabled for *tables only* — not the full GFM umbrella. Tables are a
// modeled construct; strikethrough, task lists, and autolinks are deliberately
// left as plain CommonMark text so they stay frozen rather than silently losing
// their syntax when an edited block re-serializes. Widen this only when those
// constructs are actually modeled.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import type { Root } from 'mdast';

// Constructed once and reused — the extension factories return stateless config
// that fromMarkdown only reads, so rebuilding them per parse was pure allocation
// on a hot path (the serialize idempotence guard parses on every snapshot).
const extensions = [gfmTable()];
const mdastExtensions = [gfmTableFromMarkdown()];

// A soft break is presentation, not content: CommonMark renders the single
// newline inside a paragraph as a space, so hard-wrapped source must not paint
// its wrap points in the editor. A soft break only ever lives in a `text` node's
// value (hard breaks are distinct `break` nodes; `code`/`inlineCode`/`html`
// values keep their newlines). Normalizing here — in the one shared parser —
// keeps the block model and the idempotence guard in step by construction: a
// wrapped paragraph and its flowed canonical form parse mdast-equal, so a clean
// or edit-reverted block still restores its original bytes.
function flowSoftBreaks(node: { type?: string; value?: string; children?: unknown[] }): void {
  if (node.type === 'text' && node.value !== undefined && node.value.includes('\n')) {
    node.value = node.value.replace(/\n/g, ' ');
    return;
  }
  if (node.children) {
    for (const child of node.children) {
      flowSoftBreaks(child as { type?: string; value?: string; children?: unknown[] });
    }
  }
}

export function parseMarkdown(md: string): Root {
  const root = fromMarkdown(md, { extensions, mdastExtensions }) as Root;
  flowSoftBreaks(root);
  return root;
}
