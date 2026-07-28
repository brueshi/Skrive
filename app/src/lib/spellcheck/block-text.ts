// The text half of spellchecking: turning a block's inline run into the exact
// string the oracle should judge, and finding which blocks are prose at all.
//
// Two rules govern this file.
//
// OFFSET-EXACT. A misspelling comes back as a range into the string we sent, and
// that range is handed straight to the decoration overlay, which resolves it in
// the surface's flat offset space (atoms occupy one cell, a tag occupies
// `#name`). So the string must be the same length, cell for cell, as the block's
// flat offsets — never a "readable" reduction of it.
//
// MASK, DON'T DROP. Text that is not prose (an inline code span, a tag, an
// image) must not be judged, but deleting it would shift every offset after it.
// Instead each such cell becomes U+FFFC, the object-replacement character: a
// symbol, so every word-breaker treats it as a boundary, and exactly one cell
// wide. The oracle sees a gap where the non-prose was, and the offsets still
// line up.

import type { BlockNode, InlineNode } from '../blockmodel';

/** The mask character. U+FFFC (OBJECT REPLACEMENT CHARACTER) is in Unicode
 *  category So, so word-breaking treats it as a separator rather than a letter —
 *  masked content can never merge with its neighbours into a "word". */
export const MASK_CHAR = '\uFFFC';

/** One prose leaf to check: a block id and the masked, offset-exact text of its
 *  inline run. */
export type BlockText = { id: string; text: string };

/** The masked, offset-exact text of one inline run.
 *
 *  Inline code is masked because code is not prose (the same call the renderer
 *  makes when it marks code elements `spellcheck="false"`). A tag is masked
 *  because `#draft-two` is an identifier the writer chose, not a word anyone
 *  should be corrected on. Images, breaks and footnote references are one cell
 *  each and carry no prose at all. */
export function maskedInlineText(nodes: readonly InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.marks.code ? MASK_CHAR.repeat(node.text.length) : node.text;
    } else if (node.kind === 'tag') {
      // A tag's cells are `#` + name — mask the whole run to keep the width.
      out += MASK_CHAR.repeat(1 + node.name.length);
    } else {
      // image / break / footnote_ref: one cell each.
      out += MASK_CHAR;
    }
  }
  return out;
}

/** True when a string is entirely mask and whitespace — nothing for the oracle
 *  to judge, so the caller can skip the round trip. */
export function isCheckable(text: string): boolean {
  for (const ch of text) {
    if (ch !== MASK_CHAR && !/\s/.test(ch)) return true;
  }
  return false;
}

/** Every prose leaf inside one block, in document order — the block itself for a
 *  paragraph or heading, or its descendants for a container.
 *
 *  Scope matches the decoration overlay's: paragraphs and headings at any depth
 *  inside lists, blockquotes and footnote definitions. Code blocks are verbatim
 *  text, and table cells are addressed by coordinates rather than a block id, so
 *  neither can carry a block-keyed decoration today — they are a follow-up, not
 *  a silent omission. */
export function proseLeavesIn(block: BlockNode, out: BlockText[] = []): BlockText[] {
  if (block.type === 'paragraph' || block.type === 'heading') {
    out.push({ id: block.id, text: maskedInlineText(block.inline) });
  } else if (block.type === 'blockquote' || block.type === 'footnote_definition') {
    for (const child of block.children) proseLeavesIn(child, out);
  } else if (block.type === 'bullet_list' || block.type === 'ordered_list') {
    for (const item of block.items) for (const child of item.children) proseLeavesIn(child, out);
  }
  return out;
}

/** The prose leaves of several top-level blocks, in document order. */
export function proseLeaves(blocks: readonly BlockNode[]): BlockText[] {
  const out: BlockText[] = [];
  for (const block of blocks) proseLeavesIn(block, out);
  return out;
}
