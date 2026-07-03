// Markdown export: `.folio` -> canonical Markdown, via the block model.
//
// The path is `folioToModel` (drop document identity, fill inert fidelity
// defaults) then `serializeDocument` (the existing block-model -> Markdown
// serializer). Because folio blocks carry `src: null` / `dirty: false` and are
// never durable, the serializer always emits canonical bytes with no
// `<!-- sk:ID -->` anchor comments — clean, portable Markdown.
//
// The one target-specific step is table rectangularization. A `.folio` table
// may be ragged (rows of differing cell counts); GFM tables are strictly
// rectangular, and `serializeTable` derives the delimiter row from `align` while
// emitting each body row at its own width, so a ragged table would serialize to
// invalid GFM. We clamp/pad every table to a single column count here — an
// honest, lossy-where-the-target-can't projection (the SKR-159 lesson), not a
// change to the shared converter.

import { serializeDocument } from '../blockmodel/serialize';
import type { BlockNode, Document, TableAlign, TableBlock } from '../blockmodel/types';
import { folioToModel } from '../folio/convert';
import type { FolioDocument } from '../folio/types';

/** Pad `align` and every row to a uniform column count so the table serializes to
 *  valid GFM. Column count is the max of the alignment spec and the widest row;
 *  short rows gain empty cells, missing alignments default to `null` (unaligned). */
function rectangularizeTable(table: TableBlock): TableBlock {
  const widest = table.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const cols = Math.max(table.align.length, widest);
  if (cols === 0) return table;

  const align: TableAlign[] = Array.from({ length: cols }, (_, i) => table.align[i] ?? null);
  const rows = table.rows.map((row) => Array.from({ length: cols }, (_, i) => row[i] ?? []));
  return { ...table, align, rows };
}

/** Recursively rectangularize every table, including those nested inside
 *  blockquotes and list items. */
function fixBlock(block: BlockNode): BlockNode {
  switch (block.type) {
    case 'table':
      return rectangularizeTable(block);
    case 'blockquote':
      return { ...block, children: block.children.map(fixBlock) };
    case 'bullet_list':
    case 'ordered_list':
      return {
        ...block,
        items: block.items.map((item) => ({ ...item, children: item.children.map(fixBlock) }))
      };
    default:
      return block;
  }
}

function rectangularizeTables(doc: Document): Document {
  return { ...doc, blocks: doc.blocks.map(fixBlock) };
}

/** Export a `.folio` document to canonical Markdown. */
export function folioToMarkdown(folio: FolioDocument): string {
  return serializeDocument(rectangularizeTables(folioToModel(folio)));
}
