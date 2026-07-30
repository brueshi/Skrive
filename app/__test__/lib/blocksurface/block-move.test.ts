// Top-level block reorder and insert-above — the model half of the per-block
// affordance layer, before any chrome exists to drive it. Pure transforms,
// asserted through the Markdown floor so the SEAM handling is visible: a reorder
// that produced correct block order but stray or missing blank lines would pass a
// structural assertion and still corrupt the file.

import { describe, it, expect } from 'vitest';
import { insertBlockBefore, moveBlock } from '../../../src/lib/blocksurface/range-ops';
import { parseDocument } from '../../../src/lib/blockmodel/parse';
import { serializeDocument } from '../../../src/lib/blockmodel/serialize';
import type { BlockNode, Document, InlineNode } from '../../../src/lib/blockmodel/types';
import { modelToFolio } from '../../../src/lib/folio/convert';
import { folioToMarkdown } from '../../../src/lib/export/markdown';

function plain(inline: InlineNode[]): string {
  return inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');
}
/** Top-level block order as plain text, which is what a reorder is about. */
function order(blocks: BlockNode[]): string[] {
  return blocks.map((b) => (b.type === 'paragraph' || b.type === 'heading' ? plain(b.inline) : b.type));
}
function idOf(blocks: BlockNode[], text: string): string {
  const b = blocks.find((x) => (x.type === 'paragraph' || x.type === 'heading') && plain(x.inline) === text);
  if (!b) throw new Error(`no top-level block: ${text}`);
  return b.id;
}
const doc = (md: string): Document => parseDocument(md);
const ser = (blocks: BlockNode[], base: Document): string => serializeDocument({ ...base, blocks });

describe('moveBlock', () => {
  it('moves a block down to a later boundary', () => {
    const d = doc('a\n\nb\n\nc\n');
    const blocks = moveBlock(d.blocks, idOf(d.blocks, 'a'), 2)!;
    expect(order(blocks)).toEqual(['b', 'a', 'c']);
    expect(ser(blocks, d)).toBe('b\n\na\n\nc\n');
  });

  it('moves a block up to an earlier boundary', () => {
    const d = doc('a\n\nb\n\nc\n');
    const blocks = moveBlock(d.blocks, idOf(d.blocks, 'c'), 1)!;
    expect(order(blocks)).toEqual(['a', 'c', 'b']);
    expect(ser(blocks, d)).toBe('a\n\nc\n\nb\n');
  });

  it('moves a block to the very top without opening the file on a blank line', () => {
    // The seam bug this guards: `c` carries a captured "\n\n" that gapForSeam
    // would happily emit at index 0.
    const d = doc('a\n\nb\n\nc\n');
    const blocks = moveBlock(d.blocks, idOf(d.blocks, 'c'), 0)!;
    expect(order(blocks)).toEqual(['c', 'a', 'b']);
    expect(ser(blocks, d)).toBe('c\n\na\n\nb\n');
  });

  it('moves the first block to the end without gluing the new first block to nothing', () => {
    // The mirror bug: `a` had no captured seam (it opened the file), and `b` is
    // promoted to first — its captured "\n\n" must not survive.
    const d = doc('a\n\nb\n\nc\n');
    const blocks = moveBlock(d.blocks, idOf(d.blocks, 'a'), 3)!;
    expect(order(blocks)).toEqual(['b', 'c', 'a']);
    expect(ser(blocks, d)).toBe('b\n\nc\n\na\n');
  });

  it('reorders across a barrier, keeping the barrier intact', () => {
    const d = doc('a\n\n---\n\nb\n');
    const blocks = moveBlock(d.blocks, idOf(d.blocks, 'b'), 0)!;
    expect(order(blocks)).toEqual(['b', 'a', 'horizontal_rule']);
    expect(ser(blocks, d)).toBe('b\n\na\n\n---\n');
  });

  it('moves a whole list as one block', () => {
    const d = doc('- one\n- two\n\nafter\n');
    const blocks = moveBlock(d.blocks, idOf(d.blocks, 'after'), 0)!;
    expect(order(blocks)).toEqual(['after', 'bullet_list']);
    expect(ser(blocks, d)).toBe('after\n\n- one\n- two\n');
  });

  it('leaves an untouched block byte-pristine', () => {
    // A moved block keeps `dirty` false, so a clean block still emits its verbatim
    // src rather than being re-rendered from the model.
    const d = doc('# Heading\n\nbody\n');
    const blocks = moveBlock(d.blocks, idOf(d.blocks, 'body'), 0)!;
    expect(ser(blocks, d)).toBe('body\n\n# Heading\n');
  });

  it('returns null on the boundaries flanking the block', () => {
    const d = doc('a\n\nb\n\nc\n');
    const id = idOf(d.blocks, 'b');
    expect(moveBlock(d.blocks, id, 1), 'boundary above b').toBeNull();
    expect(moveBlock(d.blocks, id, 2), 'boundary below b').toBeNull();
  });

  it('returns null for an out-of-range boundary', () => {
    const d = doc('a\n\nb\n');
    expect(moveBlock(d.blocks, idOf(d.blocks, 'a'), -1)).toBeNull();
    expect(moveBlock(d.blocks, idOf(d.blocks, 'a'), 3)).toBeNull();
  });

  it('returns null for a nested block rather than lifting it out of its list', () => {
    const d = doc('- one\n\nafter\n');
    const list = d.blocks.find((b) => b.type === 'bullet_list');
    const nested = list && list.type === 'bullet_list' ? list.items[0]!.children[0]! : null;
    expect(nested, 'fixture has a nested child').not.toBeNull();
    expect(moveBlock(d.blocks, nested!.id, 0)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    const d = doc('a\n');
    expect(moveBlock(d.blocks, 'nope', 0)).toBeNull();
  });

  it('round-trips: moving a block and moving it back restores the bytes', () => {
    const d = doc('a\n\nb\n\nc\n');
    const there = moveBlock(d.blocks, idOf(d.blocks, 'a'), 3)!;
    const back = moveBlock(there, idOf(there, 'a'), 0)!;
    expect(ser(back, d)).toBe('a\n\nb\n\nc\n');
  });
});

describe('insertBlockBefore', () => {
  it('inserts an empty paragraph above and puts the caret in it', () => {
    const d = doc('a\n\nb\n');
    const r = insertBlockBefore(d.blocks, idOf(d.blocks, 'b'))!;
    expect(order(r.blocks)).toEqual(['a', '', 'b']);
    expect(r.caret.offset).toBe(0);
    expect(r.caret.id, 'caret is in the NEW block').toBe(r.blocks[1]!.id);
  });

  it('inserts above the first block', () => {
    const d = doc('a\n\nb\n');
    const r = insertBlockBefore(d.blocks, idOf(d.blocks, 'a'))!;
    expect(order(r.blocks)).toEqual(['', 'a', 'b']);
    expect(r.blocks[0]!.id).toBe(r.caret.id);
  });

  it('is invisible in Markdown until typed into, and materializes once it holds text', () => {
    // An empty paragraph has no Markdown form, so the serializer drops it whole —
    // seam and all — rather than growing the file a stray blank line.
    const d = doc('a\n\nb\n');
    const r = insertBlockBefore(d.blocks, idOf(d.blocks, 'b'))!;
    expect(ser(r.blocks, d)).toBe('a\n\nb\n');

    const filled = r.blocks.map((b) =>
      b.id === r.caret.id && b.type === 'paragraph'
        ? { ...b, inline: [{ kind: 'text', text: 'new', marks: {} }] as InlineNode[] }
        : b
    );
    expect(ser(filled, d)).toBe('a\n\nnew\n\nb\n');
  });

  it('mints a fresh id each time', () => {
    const d = doc('a\n');
    const first = insertBlockBefore(d.blocks, idOf(d.blocks, 'a'))!;
    const second = insertBlockBefore(d.blocks, idOf(d.blocks, 'a'))!;
    expect(first.caret.id).not.toBe(second.caret.id);
  });

  it('returns null for a nested block', () => {
    const d = doc('- one\n');
    const list = d.blocks.find((b) => b.type === 'bullet_list');
    const nested = list && list.type === 'bullet_list' ? list.items[0]!.children[0]! : null;
    expect(insertBlockBefore(d.blocks, nested!.id)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    const d = doc('a\n');
    expect(insertBlockBefore(d.blocks, 'nope')).toBeNull();
  });
});

describe('export fidelity after a reorder', () => {
  // The acceptance criterion the dual-mode rework put on this feature: a reordered
  // document must EXPORT faithfully. Byte-stability was retired with the
  // Markdown-canonical model, so this asserts content and order survive the real
  // pipeline (block model -> .folio -> Markdown), not that bytes match.
  const folioOf = (blocks: BlockNode[], base: Document) =>
    modelToFolio({ ...base, blocks }, { docId: 'test', docMeta: { title: null, createdAt: '2026-01-01T00:00:00Z' } });

  it('exports a reordered document in its new order', () => {
    const d = doc('# One\n\nbody one\n\n## Two\n\nbody two\n');
    const moved = moveBlock(d.blocks, idOf(d.blocks, 'body two'), 0)!;
    const md = folioToMarkdown(folioOf(moved, d));
    expect(md.indexOf('body two'), 'the moved paragraph now leads').toBeLessThan(md.indexOf('# One'));
  });

  it('keeps a reordered list and code block intact through export', () => {
    const d = doc('intro\n\n- one\n- two\n\n```js\ncode()\n```\n');
    const moved = moveBlock(d.blocks, idOf(d.blocks, 'intro'), 3)!;
    const md = folioToMarkdown(folioOf(moved, d));
    expect(md).toContain('- one');
    expect(md).toContain('- two');
    expect(md).toContain('code()');
    expect(md.indexOf('intro'), 'intro moved to the end').toBeGreaterThan(md.indexOf('code()'));
  });

  it('separates blocks properly after a reorder rather than running them together', () => {
    // The seam clearing matters just as much here: an export that glued two
    // paragraphs into one would still "contain" both strings.
    const d = doc('a\n\nb\n\nc\n');
    const moved = moveBlock(d.blocks, idOf(d.blocks, 'c'), 0)!;
    const md = folioToMarkdown(folioOf(moved, d));
    expect(md.trimEnd().split(/\n{2,}/)).toEqual(['c', 'a', 'b']);
  });
});
