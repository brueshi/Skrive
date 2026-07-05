// @vitest-environment jsdom
//
// Block conversion in containers and across multi-block selections (SKR-169 /
// F84 + F50). Before this, setBlockType / the list & quote toggles / Tab resolved
// only a single TOP-LEVEL block, so every conversion silently no-opped when the
// caret sat inside a list item or blockquote, and a multi-block selection only
// ever touched the block at the range start (or fell through to native focus
// escape on Tab). The fix resolves the focused LEAF and maps over the whole
// selection, one history step per gesture.
//
// Driven directly in jsdom: place the caret / selection, invoke the surface
// command, assert the model. Mirrors the marks path (selectedLeaves) the ticket
// points at as the proven pattern.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../jsdom-range-rect';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const plain = (inline: InlineNode[]): string => inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');
const types = (s: BlockSurface): string[] => s.getDocument().blocks.map((b) => b.type);
type Para = Extract<BlockNode, { type: 'paragraph' }>;
type Head = Extract<BlockNode, { type: 'heading' }>;
type Quote = Extract<BlockNode, { type: 'blockquote' }>;
type List = Extract<BlockNode, { type: 'bullet_list' | 'ordered_list' }>;

function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}
function selectRange(sn: Node, so: number, en: Node, eo: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo);
  sel.addRange(range);
}
function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
  return e;
}
const api = (s: BlockSurface) =>
  s as unknown as {
    setBlockType(spec: unknown): void;
    toggleList(t: 'bullet_list' | 'ordered_list'): void;
    toggleQuote(): void;
  };

describe('Turn into from inside a container (SKR-169 / F84)', () => {
  it('lifts a list item out of the list and converts it to a heading', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- alpha\n- beta\n- gamma\n') });
    const beta = container.querySelectorAll('li p')[1]!;
    caretIn(beta.firstChild!, 1);

    api(s).setBlockType({ kind: 'heading', level: 1 });

    const blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['bullet_list', 'heading', 'bullet_list']);
    expect((blocks[1] as Head).level).toBe(1);
    expect(plain((blocks[1] as Head).inline)).toBe('beta');
    // The list survives, split around the lifted item.
    expect(plain(((blocks[0] as List).items[0]!.children[0] as Para).inline)).toBe('alpha');
    expect(plain(((blocks[2] as List).items[0]!.children[0] as Para).inline)).toBe('gamma');

    s.undo();
    const undone = s.getDocument().blocks;
    expect(undone.map((b) => b.type)).toEqual(['bullet_list']);
    expect((undone[0] as List).items.map((it) => plain((it.children[0] as Para).inline))).toEqual([
      'alpha',
      'beta',
      'gamma'
    ]);
  });

  it('converts a blockquote child in place, staying inside the quote', () => {
    const s = new BlockSurface({ container, doc: parseDocument('> quoted\n') });
    const p = container.querySelector('blockquote p')!;
    caretIn(p.firstChild!, 1);

    api(s).setBlockType({ kind: 'heading', level: 2 });

    const blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['blockquote']);
    const child = (blocks[0] as Quote).children[0]!;
    expect(child.type).toBe('heading');
    expect((child as Head).level).toBe(2);
    expect(plain((child as Head).inline)).toBe('quoted');
  });

  it('inserts a divider AFTER the list, leaving the list untouched', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- alpha\n- beta\n') });
    const alpha = container.querySelector('li p')!;
    caretIn(alpha.firstChild!, 1);

    api(s).setBlockType({ kind: 'divider' });

    const blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['bullet_list', 'horizontal_rule', 'paragraph']);
    expect((blocks[0] as List).items.map((it) => plain((it.children[0] as Para).inline))).toEqual(['alpha', 'beta']);
  });
});

describe('Multi-block Turn into (SKR-169 / F50)', () => {
  it('converts every selected leaf and one undo restores all', () => {
    const s = new BlockSurface({ container, doc: parseDocument('one\n\ntwo\n\nthree\n') });
    const ps = container.querySelectorAll('p');
    selectRange(ps[0]!.firstChild!, 0, ps[2]!.firstChild!, 5);

    api(s).setBlockType({ kind: 'heading', level: 1 });

    expect(types(s)).toEqual(['heading', 'heading', 'heading']);
    s.undo();
    expect(types(s)).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  it('skips a code block in the selection, converting the prose around it', () => {
    const s = new BlockSurface({ container, doc: parseDocument('one\n\n```\ncode\n```\n\ntwo\n') });
    const ps = container.querySelectorAll('p');
    selectRange(ps[0]!.firstChild!, 0, ps[1]!.firstChild!, 3);

    api(s).setBlockType({ kind: 'heading', level: 2 });

    const blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'code_block', 'heading']);
    expect((blocks[1] as Extract<BlockNode, { type: 'code_block' }>).text).toBe('code');
  });
});

describe('Multi-block list / quote toggles (SKR-169 / F50)', () => {
  it('wraps the selected blocks into ONE bullet list, and a repeat unwraps', () => {
    const s = new BlockSurface({ container, doc: parseDocument('one\n\ntwo\n') });
    const ps = container.querySelectorAll('p');
    selectRange(ps[0]!.firstChild!, 0, ps[1]!.firstChild!, 3);

    const first = key(s, { code: 'Digit8', key: '*', metaKey: true, shiftKey: true });
    expect(first.defaultPrevented).toBe(true);
    let blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['bullet_list']);
    expect((blocks[0] as List).items.map((it) => plain((it.children[0] as Para).inline))).toEqual(['one', 'two']);

    key(s, { code: 'Digit8', key: '*', metaKey: true, shiftKey: true });
    blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(blocks.map((b) => plain((b as Para).inline))).toEqual(['one', 'two']);
  });

  it('wraps the selected blocks into ONE quote, and an already-quoted selection unwraps', () => {
    const s = new BlockSurface({ container, doc: parseDocument('one\n\ntwo\n') });
    const ps = container.querySelectorAll('p');
    selectRange(ps[0]!.firstChild!, 0, ps[1]!.firstChild!, 3);

    api(s).toggleQuote();
    let blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['blockquote']);
    expect((blocks[0] as Quote).children.map((c) => plain((c as Para).inline))).toEqual(['one', 'two']);

    api(s).toggleQuote();
    blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(blocks.map((b) => plain((b as Para).inline))).toEqual(['one', 'two']);
  });
});

describe('Multi-item list Tab (SKR-169 / F50)', () => {
  it('indents every selected item and never escapes focus; Shift+Tab reverses it', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- a\n- b\n- c\n') });
    const items = container.querySelectorAll('li p');
    selectRange(items[1]!.firstChild!, 0, items[2]!.firstChild!, 1);

    const tab = key(s, { key: 'Tab' });
    expect(tab.defaultPrevented, 'Tab must be consumed, not a native focus escape').toBe(true);
    // b and c are now nested under a (one top-level item, two nested).
    let list = s.getDocument().blocks[0] as List;
    expect(list.items).toHaveLength(1);
    const sub = list.items[0]!.children.find((c) => c.type === 'bullet_list') as List | undefined;
    expect(sub).toBeDefined();
    expect(sub!.items.map((it) => plain((it.children[0] as Para).inline))).toEqual(['b', 'c']);

    // Re-select the nested items and outdent them back to the top level.
    const nested = container.querySelectorAll('li li p');
    selectRange(nested[0]!.firstChild!, 0, nested[1]!.firstChild!, 1);
    const shiftTab = key(s, { key: 'Tab', shiftKey: true });
    expect(shiftTab.defaultPrevented).toBe(true);
    list = s.getDocument().blocks[0] as List;
    expect(list.items.map((it) => plain((it.children[0] as Para).inline))).toEqual(['a', 'b', 'c']);
  });
});

describe('Toolbar state reflects the resolved leaf (SKR-169 / F84)', () => {
  it('shows list context for a list item and quote context for a quoted heading', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- alpha\n') });
    caretIn(container.querySelector('li p')!.firstChild!, 1);
    const listInfo = s.getSelectionInfo();
    expect(listInfo?.blockType).toBe('paragraph');
    expect(listInfo?.inBulletList).toBe(true);
    expect(listInfo?.inBlockquote).toBe(false);

    container.textContent = '';
    const s2 = new BlockSurface({ container, doc: parseDocument('> # quoted heading\n') });
    const leaf = container.querySelector('blockquote')!.querySelector('[data-block-id]')!;
    caretIn(leaf.firstChild!, 1);
    const quoteInfo = s2.getSelectionInfo();
    expect(quoteInfo?.blockType).toBe('heading');
    expect(quoteInfo?.headingLevel).toBe(1);
    expect(quoteInfo?.inBlockquote).toBe(true);
  });
});
