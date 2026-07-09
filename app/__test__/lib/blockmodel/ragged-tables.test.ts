// Ragged tables at the md->model boundary (SKR-159 / F09). GFM lets a row carry
// more or fewer cells than its header, and the two directions are not symmetric:
// a short row is padded (lossless, and what the spec prescribes), while a row with
// excess cells used to be clamped to the header's width. mdast holds those cells;
// the model read past them and threw them away — silently, with no freeze and no
// signal, and with no way back after an import, which is one-way.
//
// The table is now sized to its widest row. It stays rectangular, because every
// consumer (render.ts, the cell selection map, Tab-between-cells, and structure
// editing later) indexes rows against one column count.

import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from '../../../src/lib/blockmodel';
import type { BlockNode, TableBlock } from '../../../src/lib/blockmodel';

function table(md: string): TableBlock {
  const block = parseDocument(md).blocks[0];
  if (!block || block.type !== 'table') throw new Error(`expected a table, got ${block?.type}`);
  return block;
}

/** Cell text, row by row — the shape a reader cares about. */
function grid(t: TableBlock): string[][] {
  return t.rows.map((row) => row.map((cell) => cell.map((n) => (n.kind === 'text' ? n.text : '')).join('')));
}

const dirty = (block: BlockNode): BlockNode => ({ ...block, dirty: true }) as BlockNode;

describe('a row with excess cells', () => {
  const RAGGED = '| a | b |\n| - | - |\n| 1 | 2 | 3 |\n';

  it('keeps the cell the header has no column for', () => {
    expect(grid(table(RAGGED))).toEqual([
      ['a', 'b', ''],
      ['1', '2', '3']
    ]);
  });

  it('widens the header and the alignment to match', () => {
    const t = table(RAGGED);
    expect(t.align).toHaveLength(3);
    expect(t.rows.every((row) => row.length === 3), 'the model stays rectangular').toBe(true);
  });

  it('re-serializes as a valid table that reloads identically', () => {
    const doc = parseDocument(RAGGED);
    const md = serializeDocument({ ...doc, blocks: doc.blocks.map(dirty) });
    expect(md).toBe('| a | b |  |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n');
    expect(grid(table(md))).toEqual(grid(table(RAGGED)));
  });

  it('takes the widest row, not merely the second one', () => {
    const t = table('| a |\n| - |\n| 1 | 2 |\n| 3 | 4 | 5 |\n');
    expect(grid(t)).toEqual([
      ['a', '', ''],
      ['1', '2', ''],
      ['3', '4', '5']
    ]);
  });
});

describe('a row with too few cells', () => {
  // Padding a short row is what GFM itself prescribes, and it loses nothing.
  it('pads to the header width, as before', () => {
    expect(grid(table('| a | b |\n| - | - |\n| 1 |\n'))).toEqual([
      ['a', 'b'],
      ['1', '']
    ]);
  });
});

describe('an ordinary table', () => {
  it('is untouched', () => {
    const t = table('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(grid(t)).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
    expect(t.align).toHaveLength(2);
  });

  it('keeps its alignment row', () => {
    const t = table('| a | b |\n| :- | -: |\n| 1 | 2 |\n');
    expect(t.align).toEqual(['left', 'right']);
  });

  it('a clean ragged table still re-emits its source bytes verbatim', () => {
    const RAGGED = '| a | b |\n| - | - |\n| 1 | 2 | 3 |\n';
    expect(serializeDocument(parseDocument(RAGGED))).toBe(RAGGED);
  });
});
