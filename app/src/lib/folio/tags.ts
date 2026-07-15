// Extract the distinct inline tags from a `.folio` body, for the manifest tag
// index. Reads the native format (where a tag persists as its own leaf), so it is
// exact — unlike a Markdown text scan, which can't cheaply tell a `#tag` in prose
// from one inside a code span. A malformed body yields no tags rather than failing
// the scan.

import { parseFolio } from './parse';
import type { FolioBlock, FolioInline } from './types';

function collectFromInline(nodes: FolioInline[], out: Set<string>): void {
  for (const n of nodes) if (n.kind === 'tag') out.add(n.name);
}

function collectFromBlocks(blocks: FolioBlock[], out: Set<string>): void {
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        collectFromInline(b.inline, out);
        break;
      case 'blockquote':
        collectFromBlocks(b.children, out);
        break;
      case 'bullet_list':
      case 'ordered_list':
        for (const item of b.items) collectFromBlocks(item.children, out);
        break;
      case 'table':
        for (const row of b.rows) for (const cell of row) collectFromInline(cell, out);
        break;
    }
  }
}

/** The sorted, de-duplicated inline tag names in a `.folio` body. Returns `[]` when
 *  the body is empty or cannot be parsed as a `.folio` document. */
export function folioTagNames(body: string): string[] {
  if (!body) return [];
  let blocks: FolioBlock[];
  try {
    blocks = parseFolio(body).blocks;
  } catch {
    return [];
  }
  const out = new Set<string>();
  collectFromBlocks(blocks, out);
  return [...out].sort((a, b) => a.localeCompare(b));
}
