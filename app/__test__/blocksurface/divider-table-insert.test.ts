// @vitest-environment jsdom
//
// Divider/table insert destroys content instead of inserting beside it (SKR-170
// / F66, severity S2). setBlockType({kind:'divider'}) always routed through
// replaceWithDivider, and setBlockType({kind:'table'}) always built a fresh empty
// 2x2 and replaced the current block — both dropping the block's inline text
// whenever the toolbar or command palette invoked them with the caret in a
// non-empty paragraph or heading. Only the slash menu was safe, and only because
// it requires an empty block to open in the first place.
//
// The fix: setBlockType now checks whether the current block is empty. Empty
// keeps the old replace-in-place behavior (the slash-menu path, unchanged by
// construction). Non-empty splices the divider/table in AFTER the current block,
// leaving its text untouched. A divider has no caret home of its own, so it seeds
// a trailing paragraph when there's no existing inline block to land in
// (mirroring exitBarrier's "never a trap" seeding) — a table always lands the
// caret in its own first cell, same as the empty-block path already did.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../jsdom-range-rect';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';
import { setCaret } from '../../src/lib/blocksurface/selection';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const plain = (inline: InlineNode[]): string => inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');

function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}
function setType(surface: BlockSurface, spec: unknown): void {
  (surface as unknown as { setBlockType(s: unknown): void }).setBlockType(spec);
}
function applySlash(surface: BlockSurface, spec: unknown): void {
  (surface as unknown as { applySlashCommand(s: unknown): void }).applySlashCommand(spec);
}
function blocksOf(surface: BlockSurface): BlockNode[] {
  return surface.getDocument().blocks;
}
function leafTargetOf(surface: BlockSurface): { leaf: BlockNode; start: number } | null {
  return (surface as unknown as { leafTarget(): { leaf: BlockNode; start: number } | null }).leafTarget();
}
function cellTargetOf(surface: BlockSurface): { tableId: string; row: number; col: number } | null {
  return (surface as unknown as { cellTarget(): { tableId: string; row: number; col: number } | null }).cellTarget();
}

describe('Divider insert beside a non-empty block (SKR-170 / F66)', () => {
  it('leaves the paragraph text intact and inserts the hr after it', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n\nworld\n') });
    const helloId = blocksOf(surface)[0]!.id;
    const p = container.querySelectorAll('p')[0]!;
    caretIn(p.firstChild!, 3); // mid-text caret; should not matter (insert-below regardless of offset)

    setType(surface, { kind: 'divider' });

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'horizontal_rule', 'paragraph']);
    expect(blocks[0]!.id).toBe(helloId);
    expect(plain((blocks[0] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('hello');
    expect(plain((blocks[2] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('world');
  });

  it('lands the caret at the start of the existing following block', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n\nworld\n') });
    const p = container.querySelectorAll('p')[0]!;
    caretIn(p.firstChild!, 0);

    setType(surface, { kind: 'divider' });

    const t = leafTargetOf(surface);
    expect(t?.leaf.type).toBe('paragraph');
    expect(plain((t?.leaf as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('world');
    expect(t?.start).toBe(0);
  });

  it('one undo removes only the hr', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n\nworld\n') });
    const p = container.querySelectorAll('p')[0]!;
    caretIn(p.firstChild!, 0);

    setType(surface, { kind: 'divider' });
    expect(blocksOf(surface).map((b) => b.type)).toEqual(['paragraph', 'horizontal_rule', 'paragraph']);

    surface.undo();

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(plain((blocks[0] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('hello');
    expect(plain((blocks[1] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('world');
  });

  it('seeds a trailing paragraph when the current block is last', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const p = container.querySelectorAll('p')[0]!;
    caretIn(p.firstChild!, 2);

    setType(surface, { kind: 'divider' });

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'horizontal_rule', 'paragraph']);
    expect(plain((blocks[0] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('hello');
    expect(plain((blocks[2] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe(''); // seeded empty
    const t = leafTargetOf(surface);
    expect(t?.leaf.id).toBe(blocks[2]!.id);
    expect(t?.start).toBe(0);
  });

  it('inserts after a non-empty heading, leaving it intact', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('# Title\n\nbody\n') });
    const headingId = blocksOf(surface)[0]!.id;
    const h1 = container.querySelectorAll('h1')[0]!;
    caretIn(h1.firstChild!, 1);

    setType(surface, { kind: 'divider' });

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'horizontal_rule', 'paragraph']);
    expect(blocks[0]!.id).toBe(headingId);
    expect((blocks[0] as Extract<BlockNode, { type: 'heading' }>).level).toBe(1);
    expect(plain((blocks[0] as Extract<BlockNode, { type: 'heading' }>).inline)).toBe('Title');
    expect(plain((blocks[2] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('body');
  });
});

describe('Table insert beside a non-empty block (SKR-170 / F66)', () => {
  it('leaves the paragraph text intact and inserts an empty 2x2 table after it', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n\nworld\n') });
    const helloId = blocksOf(surface)[0]!.id;
    const p = container.querySelectorAll('p')[0]!;
    caretIn(p.firstChild!, 3);

    setType(surface, { kind: 'table' });

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(blocks[0]!.id).toBe(helloId);
    expect(plain((blocks[0] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('hello');
    expect(plain((blocks[2] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('world');
  });

  it('lands the caret in the first cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n\nworld\n') });
    const p = container.querySelectorAll('p')[0]!;
    caretIn(p.firstChild!, 0);

    setType(surface, { kind: 'table' });

    const cell = cellTargetOf(surface);
    expect(cell?.row).toBe(0);
    expect(cell?.col).toBe(0);
  });

  it('one undo removes only the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const p = container.querySelectorAll('p')[0]!;
    caretIn(p.firstChild!, 0);

    setType(surface, { kind: 'table' });
    expect(blocksOf(surface).map((b) => b.type)).toEqual(['paragraph', 'table']);

    surface.undo();

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(plain((blocks[0] as Extract<BlockNode, { type: 'paragraph' }>).inline)).toBe('hello');
  });
});

describe('Empty block still replaces (unchanged behavior)', () => {
  it('setBlockType divider replaces an empty paragraph directly', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('\n') });
    const p = container.querySelectorAll('p')[0]!;
    setCaret(p, 0);

    setType(surface, { kind: 'divider' });

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['horizontal_rule', 'paragraph']);
  });

  it('setBlockType table replaces an empty paragraph directly', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('\n') });
    const p = container.querySelectorAll('p')[0]!;
    setCaret(p, 0);

    setType(surface, { kind: 'table' });

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['table']);
  });

  it('the slash path still replaces an empty block with a divider', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('\n') });
    const p = container.querySelectorAll('p')[0]!;
    setCaret(p, 0);
    (surface as unknown as { applyInsertText(t: string): void }).applyInsertText('/');

    applySlash(surface, { kind: 'divider' });

    expect(blocksOf(surface)[0]!.type).toBe('horizontal_rule');
  });

  it('the slash path still replaces an empty block with a table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('\n') });
    const p = container.querySelectorAll('p')[0]!;
    setCaret(p, 0);
    (surface as unknown as { applyInsertText(t: string): void }).applyInsertText('/');

    applySlash(surface, { kind: 'table' });

    expect(blocksOf(surface)[0]!.type).toBe('table');
  });
});
