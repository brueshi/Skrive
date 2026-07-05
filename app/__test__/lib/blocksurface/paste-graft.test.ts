// Pure paste-placement transforms (SKR-174). spliceParsedAtLeaf splits an inline
// leaf around pasted blocks (keeping the caret block's identity); graftIntoContainer
// grafts into a list/quote and splits out what a container can't hold. Both are
// pure and DOM-free, so they test directly against the block model.

import { describe, it, expect } from 'vitest';
import { graftIntoContainer, spliceParsedAtLeaf } from '../../../src/lib/blocksurface/paste-graft';
import { parseDocument, type BlockNode } from '../../../src/lib/blockmodel';

let n = 0;
const gen = () => `gen-${n++}`;

function para(t: string): BlockNode {
  return parseDocument(`${t}\n`).blocks[0]!;
}
function heading(t: string, level: number): BlockNode {
  return parseDocument(`${'#'.repeat(level)} ${t}\n`).blocks[0]!;
}
function textOf(b: BlockNode): string {
  return 'inline' in b ? b.inline.map((x) => ('text' in x ? x.text : '')).join('') : '';
}
function itemTexts(list: BlockNode): string[] {
  if (list.type !== 'bullet_list' && list.type !== 'ordered_list') throw new Error('not a list');
  return list.items.map((it) => it.children.map(textOf).join('|'));
}

describe('spliceParsedAtLeaf', () => {
  it('keeps a paragraph tail merged into a trailing pasted paragraph', () => {
    const leaf = para('hello world');
    const { blocks } = spliceParsedAtLeaf(leaf as never, 6, [heading('H', 1), para('tail')], gen);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'paragraph']);
    expect(blocks.map(textOf)).toEqual(['hello ', 'H', 'tailworld']);
  });

  it('at a heading start, inserts before the intact heading', () => {
    const leaf = heading('Title', 1);
    const { blocks, caret } = spliceParsedAtLeaf(leaf as never, 0, [para('a'), para('b')], gen);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'heading']);
    expect(blocks.map(textOf)).toEqual(['a', 'b', 'Title']);
    expect(caret, 'caret lands at the heading start after the pasted content').toEqual({ id: blocks[2]!.id, offset: 0 });
  });

  it('mid-heading keeps the tail a heading of the same level (no demotion)', () => {
    const leaf = heading('Heading', 2);
    const { blocks } = spliceParsedAtLeaf(leaf as never, 4, [para('one'), para('two')], gen);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading']);
    // "Head" (+ first pasted paragraph merged) | "two" | "ing"
    expect(blocks.map(textOf)).toEqual(['Headone', 'two', 'ing']);
    expect((blocks[0] as Extract<BlockNode, { type: 'heading' }>).level).toBe(2);
    expect((blocks[2] as Extract<BlockNode, { type: 'heading' }>).level).toBe(2);
  });
});

describe('graftIntoContainer', () => {
  it('grafts paragraphs into a list item as sibling items', () => {
    const doc = parseDocument('- one\n- two\n');
    const leafId = (doc.blocks[0] as Extract<BlockNode, { type: 'bullet_list' }>).items[0]!.children[0]!.id;
    const r = graftIntoContainer(doc.blocks, leafId, 3, [para('A'), para('B')], gen)!;
    expect(r).not.toBeNull();
    expect(r.blocks.map((b) => b.type)).toEqual(['bullet_list']);
    expect(itemTexts(r.blocks[0]!)).toEqual(['one', 'A', 'B', 'two']);
  });

  it('splits a table out after the top-level list', () => {
    const doc = parseDocument('- one\n- two\n');
    const leafId = (doc.blocks[0] as Extract<BlockNode, { type: 'bullet_list' }>).items[0]!.children[0]!.id;
    const table = parseDocument('| a | b |\n| - | - |\n| 1 | 2 |\n').blocks[0]!;
    const r = graftIntoContainer(doc.blocks, leafId, 3, [table], gen)!;
    expect(r.blocks.map((b) => b.type)).toEqual(['bullet_list', 'table']);
    expect(itemTexts(r.blocks[0]!)).toEqual(['one', 'two']);
  });

  it('joins pasted blocks into a blockquote', () => {
    const doc = parseDocument('> quoted\n');
    const leafId = (doc.blocks[0] as Extract<BlockNode, { type: 'blockquote' }>).children[0]!.id;
    const r = graftIntoContainer(doc.blocks, leafId, 6, [para('A'), para('B')], gen)!;
    const quote = r.blocks[0]!;
    if (quote.type !== 'blockquote') throw new Error('not a quote');
    expect(quote.children.map(textOf)).toEqual(['quotedA', 'B']);
  });

  it('returns null when the leaf is not inside a container', () => {
    const doc = parseDocument('plain paragraph\n');
    const leafId = doc.blocks[0]!.id;
    expect(graftIntoContainer(doc.blocks, leafId, 0, [para('x')], gen)).toBeNull();
  });
});
