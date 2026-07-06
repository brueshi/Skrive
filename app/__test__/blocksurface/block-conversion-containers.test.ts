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

// SKR-219 papercut #1: a table cell is coordinate-addressed, not a leaf block, so
// none of the "Turn into" conversions have anything to act on there. The command
// layer already refused cleanly (setBlockType's currentConvertibleBlock resolves
// to null for a cell caret); what was missing is the dropdown/toolbar KNOWING
// that, so it rendered every conversion as if it would work. selectionSummary
// already reported inTable via the cell branch (prior table work) — this pins
// that signal at the selection-store layer, which BlockMenuController and the
// menu components consume verbatim to disable the controls (no new field).
describe('Table-cell context reports conversions unavailable (SKR-219)', () => {
  it('reports inTable / blockType "table" for a caret in a cell, and refuses setBlockType/toggleList/toggleQuote', () => {
    const s = new BlockSurface({ container, doc: parseDocument('| a | b |\n| --- | --- |\n| 1 | 2 |\n') });
    const cell = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')!;
    caretIn(cell.firstChild ?? cell, 0);

    const info = s.getSelectionInfo();
    expect(info?.inTable).toBe(true);
    expect(info?.blockType).toBe('table');

    const before = s.getDocument();
    api(s).setBlockType({ kind: 'heading', level: 1 });
    expect(s.getDocument()).toBe(before); // refused, not just "unchanged content"
    api(s).toggleList('bullet_list');
    expect(s.getDocument()).toBe(before);
    api(s).toggleQuote();
    expect(s.getDocument()).toBe(before);
  });

  it('reports inTable for a non-collapsed text selection within one cell, not just a collapsed caret', () => {
    const s = new BlockSurface({ container, doc: parseDocument('| a | b |\n| --- | --- |\n| 1 | 2 |\n') });
    const cell = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')!;
    selectRange(cell.firstChild!, 0, cell.firstChild!, 1);

    const info = s.getSelectionInfo();
    expect(info?.inTable).toBe(true);
    expect(info?.empty).toBe(false); // a real selection: the bubble would show, gated on inTable too
  });
});

// SKR-219 papercut #2: setBlockType({kind:'blockquote'}) on a heading used to
// build a fresh paragraph child (convertedBlock's legacy builder), dropping the
// heading level, even though SKR-169's multi-block wrap already preserved the
// source kind. Single-caret quote-wrap now goes through the same convertedBlock
// this test pins, so the two paths can't drift again.
describe('Single-caret quote toggle preserves heading level (SKR-219)', () => {
  it('wraps a top-level H2 in a quote that still contains an H2; toggling off restores it', () => {
    const s = new BlockSurface({ container, doc: parseDocument('## heading\n') });
    const h = container.querySelector('h2')!;
    caretIn(h.firstChild!, 1);

    api(s).toggleQuote();
    let blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['blockquote']);
    const child = (blocks[0] as Quote).children[0]!;
    expect(child.type).toBe('heading');
    expect((child as Head).level).toBe(2);
    expect(plain((child as Head).inline)).toBe('heading');

    s.undo();
    blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['heading']);
    expect((blocks[0] as Head).level).toBe(2);

    // Toggle off from the quoted heading directly (no undo): must restore a
    // top-level H2, not a paragraph.
    api(s).toggleQuote();
    caretIn(container.querySelector('blockquote h2')!.firstChild!, 1);
    api(s).toggleQuote();
    blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['heading']);
    expect((blocks[0] as Head).level).toBe(2);
    expect(plain((blocks[0] as Head).inline)).toBe('heading');

    s.undo();
    blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['blockquote']);
    expect((blocks[0] as Quote).children[0]!.type).toBe('heading');
  });
});

// SKR-219 papercut #3: choosing Bullet list / Numbered list / Quote from inside
// an existing list item lifted the item out and split the list, producing a
// redundant single-item sibling container — the "lift out" shape that IS correct
// for heading/paragraph/code (a genuine type change) is the wrong shape for
// list-to-list, which is a kind change on the SAME container abstraction.
// Semantics chosen (documented, matching Notion): same-kind is a no-op (zero
// history steps — Shift+Tab is the "leave the list" gesture, not this one);
// other-kind changes the WHOLE enclosing list's kind in place. Quote-from-a-
// list-item keeps the pre-existing lift-out shape (a quote is a genuinely
// different container, not a list-kind swap) — documented as intentional, not
// an oversight. Both entry points — the toolbar's toggleList/toggleQuote and the
// slash menu's setBlockType({kind:...}) — are covered since they used to disagree.
describe('List-to-list conversion from inside a list item (SKR-219)', () => {
  it('toggleList: same kind from inside a 3-item list is a no-op (zero history steps)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- alpha\n- beta\n- gamma\n') });
    const beta = container.querySelectorAll('li p')[1]!;
    caretIn(beta.firstChild!, 1);

    const before = s.getDocument();
    api(s).toggleList('bullet_list');
    expect(s.getDocument()).toBe(before); // no doc reassignment at all

    s.undo(); // nothing was recorded, so this is itself a no-op
    expect(s.getDocument()).toBe(before);
  });

  it('toggleList: other kind from inside a 3-item list converts the WHOLE list in place', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- alpha\n- beta\n- gamma\n') });
    const beta = container.querySelectorAll('li p')[1]!;
    const originalListId = s.getDocument().blocks[0]!.id;
    caretIn(beta.firstChild!, 1);

    api(s).toggleList('ordered_list');
    let blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['ordered_list']);
    expect(blocks[0]!.id).toBe(originalListId); // identity preserved, not a fresh sibling
    expect((blocks[0] as List).items.map((it) => plain((it.children[0] as Para).inline))).toEqual([
      'alpha',
      'beta',
      'gamma'
    ]);

    s.undo();
    blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['bullet_list']);
    expect((blocks[0] as List).items.map((it) => plain((it.children[0] as Para).inline))).toEqual([
      'alpha',
      'beta',
      'gamma'
    ]);
  });

  it('setBlockType (the slash-menu path): same kind from inside a list item is a no-op', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- alpha\n- beta\n- gamma\n') });
    const beta = container.querySelectorAll('li p')[1]!;
    caretIn(beta.firstChild!, 1);

    const before = s.getDocument();
    api(s).setBlockType({ kind: 'bullet_list' });
    expect(s.getDocument()).toBe(before);
  });

  it('setBlockType (the slash-menu path): other kind from inside a list item converts the WHOLE list in place', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- alpha\n- beta\n- gamma\n') });
    const beta = container.querySelectorAll('li p')[1]!;
    const originalListId = s.getDocument().blocks[0]!.id;
    caretIn(beta.firstChild!, 1);

    api(s).setBlockType({ kind: 'ordered_list' });
    const blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['ordered_list']);
    expect(blocks[0]!.id).toBe(originalListId);
    expect((blocks[0] as List).items.map((it) => plain((it.children[0] as Para).inline))).toEqual([
      'alpha',
      'beta',
      'gamma'
    ]);
  });

  it('Quote from inside a list item keeps the documented lift-out shape (a genuine container change, unlike list<->list)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- alpha\n- beta\n- gamma\n') });
    const beta = container.querySelectorAll('li p')[1]!;
    caretIn(beta.firstChild!, 1);

    api(s).toggleQuote();
    const blocks = s.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['bullet_list', 'blockquote', 'bullet_list']);
    expect(plain(((blocks[0] as List).items[0]!.children[0] as Para).inline)).toBe('alpha');
    const quoteChild = (blocks[1] as Quote).children[0]!;
    expect(quoteChild.type).toBe('paragraph');
    expect(plain((quoteChild as Para).inline)).toBe('beta');
    expect(plain(((blocks[2] as List).items[0]!.children[0] as Para).inline)).toBe('gamma');

    s.undo();
    expect(s.getDocument().blocks.map((b) => b.type)).toEqual(['bullet_list']);
  });
});
