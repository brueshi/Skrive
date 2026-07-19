// The single mdast parser shared by every Markdown consumer (the projection
// bridge today, the block model under the canonical inversion). Parse and the
// idempotence guard's semantic-equality check MUST go through this same
// configuration, or the two would disagree about what a string means and the
// guard would mis-fire.
//
// GFM is enabled for *tables, strikethrough, task lists, and footnotes* — not the
// full GFM umbrella. All four are modeled constructs; autolinks are deliberately
// left as plain CommonMark text so they stay frozen rather than silently losing
// their syntax when an edited block re-serializes. Widen this only when a construct
// is actually modeled. Footnotes (SKR-56): enabling the extension is what turns
// `[^1]` into a `footnoteReference` and `[^1]: …` into a `footnoteDefinition` — the
// model MUST handle both, or an unmodeled reference freezes its paragraph.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';
import type { Root } from 'mdast';

// Constructed once and reused — the extension factories return stateless config
// that fromMarkdown only reads, so rebuilding them per parse was pure allocation
// on a hot path (the serialize idempotence guard parses on every snapshot).
const extensions = [gfmTable(), gfmStrikethrough(), gfmTaskListItem(), gfmFootnote()];
const mdastExtensions = [
  gfmTableFromMarkdown(),
  gfmStrikethroughFromMarkdown(),
  gfmTaskListItemFromMarkdown(),
  gfmFootnoteFromMarkdown()
];

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

/**
 * The line-ending policy for everything downstream of Markdown: the model holds
 * LF, always (SKR-160 / F10).
 *
 * micromark does not normalize CRLF, and a soft break lives inside a `text`
 * node's value — so `alpha\r\nbeta` used to model as the literal text
 * `alpha\r beta`, with a stray CR carried as content into `.folio` on paste and
 * on import. Normalizing here, before anything reads a byte, is what makes that
 * unrepresentable rather than merely unlikely: a `\r` cannot enter the model
 * because the parser never sees one.
 *
 * `.md` files on disk keep whatever endings they have — that path saves
 * text→text and never round-trips through this parser (SKR-196).
 */
export function normalizeLineEndings(md: string): string {
  return md.replace(/\r\n?/g, '\n');
}

export function parseMarkdown(md: string): Root {
  const root = fromMarkdown(normalizeLineEndings(md), { extensions, mdastExtensions }) as Root;
  flowSoftBreaks(root);
  return root;
}
