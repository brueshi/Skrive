// @vitest-environment jsdom
//
// Structure-preserving paste placement (SKR-174 / F25, F27). Before this fix the
// paste pipeline only landed structured blocks at a COLLAPSED, top-level caret;
// everywhere else it flattened to unmarked, space-joined text. This pins the four
// defects the fix closes, case by case:
//
//   1. paste over a SELECTION deletes the selection first (through the same
//      classifier Backspace/cut use), then runs the ordinary collapsed insert at
//      the join — structure and marks survive, one undo restores everything;
//   2. paste into a CONTAINER (list item / blockquote) grafts rather than flattens
//      — pasted paragraphs/lists become sibling items, blocks join a quote, and a
//      block a container can't hold (table/code/rule) splits out AFTER it;
//   3. paste at a HEADING's start keeps the heading intact and lands the blocks
//      before it (no "para2Title" fusion), never demoting the heading to prose;
//   4. inline HTML in pasted prose stays an EDITABLE paragraph (the tag renders
//      literally), while genuine block-level HTML still freezes.
//
// paste and drop share interpretTransfer (SKR-165), so a drop case proves the
// shared path benefits too. jsdom has no DataTransfer/ClipboardEvent, so the
// handlers are driven through interpretTransfer with a minimal fake, exactly as
// the drop suite does; caret placement in the real WKWebView shell is verified
// separately (project_wkwebview_caret_blindspot).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, serializeDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
  delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
});

type Priv = {
  interpretTransfer: (data: DataTransfer, claim: () => void) => boolean;
  onDrop: (e: Event) => void;
};
const priv = (s: BlockSurface) => s as unknown as Priv;

function transfer(map: Record<string, string>): DataTransfer {
  return { getData: (t: string) => map[t] ?? '' } as unknown as DataTransfer;
}
function pasteInto(s: BlockSurface, map: Record<string, string>): void {
  priv(s).interpretTransfer(transfer(map), () => {});
}
function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.addRange(r);
}
function selectRange(sn: Node, so: number, en: Node, eo: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo);
  sel.addRange(r);
}
function blocks(s: BlockSurface): BlockNode[] {
  return s.getDocument().blocks;
}
function text(b: BlockNode): string {
  return 'inline' in b ? b.inline.map((n) => ('text' in n ? n.text : `⁣`)).join('') : '';
}
function itemTexts(list: BlockNode): string[] {
  if (list.type !== 'bullet_list' && list.type !== 'ordered_list') throw new Error('not a list');
  return list.items.map((it) => it.children.map(text).join('|'));
}
function markRuns(s: BlockSurface, mark: 'strong' | 'em'): string[] {
  const out: string[] = [];
  const walk = (bs: BlockNode[]): void => {
    for (const b of bs) {
      if ('inline' in b) for (const n of b.inline) if (n.kind === 'text' && n.marks[mark]) out.push(n.text);
      if (b.type === 'blockquote') walk(b.children);
      if (b.type === 'bullet_list' || b.type === 'ordered_list') for (const it of b.items) walk(it.children);
    }
  };
  walk(s.getDocument().blocks);
  return out;
}

describe('defect 1 — paste over a selection preserves structure and marks (one undo)', () => {
  it('structured paste (heading + list + paragraph) over a multi-block selection', () => {
    const s = new BlockSurface({ container, doc: parseDocument('alpha\n\nbeta\n\ngamma\n') });
    const ps = container.querySelectorAll('p');
    selectRange(ps[0]!.firstChild!, 2, ps[2]!.firstChild!, 3); // "alpha".."gamma" -> keep "al" + "ma"
    const before = s.getDocument();

    pasteInto(s, { 'text/plain': '# Title\n\n- one\n- two\n\ntail' });

    const bs = blocks(s);
    expect(bs.map((b) => b.type), 'structure landed, selection gone').toEqual([
      'paragraph',
      'heading',
      'bullet_list',
      'paragraph'
    ]);
    expect(text(bs[0]!)).toBe('al');
    expect(text(bs[1]!)).toBe('Title');
    expect(itemTexts(bs[2]!)).toEqual(['one', 'two']);
    expect(text(bs[3]!)).toBe('tailma');

    s.undo();
    expect(s.getDocument().blocks.map((b) => b.type), 'one undo restores the original three paragraphs').toEqual([
      'paragraph',
      'paragraph',
      'paragraph'
    ]);
    expect(s.getDocument().blocks.map(text)).toEqual(['alpha', 'beta', 'gamma']);
    // Exactly one history step: the single undo restored the exact pre-paste doc.
    expect(s.getDocument(), 'undo reached the pre-paste doc in one step').toBe(before);
  });

  it('carries the pasted marks across the selection replace', () => {
    const s = new BlockSurface({ container, doc: parseDocument('alpha\n\nbeta\n') });
    const ps = container.querySelectorAll('p');
    selectRange(ps[0]!.firstChild!, 1, ps[1]!.firstChild!, 2);

    pasteInto(s, { 'text/plain': 'x **bold** y' });

    expect(markRuns(s, 'strong'), 'the pasted bold survives (not flattened to plain text)').toEqual(['bold']);
  });

  it('a barrier endpoint follows the classifier clamp, then inserts at the join', () => {
    const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';
    const s = new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const para = container.querySelector('p')!;
    const headerCell = container.querySelector('[data-cell-row="0"][data-cell-col="0"]')!;
    selectRange(para.firstChild!, 2, headerCell.firstChild!, 0); // prose -> into the table

    pasteInto(s, { 'text/plain': '# New\n\nmore' });

    const bs = blocks(s);
    expect(text(bs[0]!), 'prose clamp-deleted to the barrier edge').toBe('he');
    expect(bs.map((b) => b.type)).toEqual(['paragraph', 'heading', 'paragraph', 'table']);
    expect(text(bs[1]!)).toBe('New');
    expect(bs[3]!.type, 'the table barrier survives the clamp').toBe('table');
  });

  it('a within-leaf selection is replaced by the structured paste', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const p = container.querySelector('p')!;
    selectRange(p.firstChild!, 6, p.firstChild!, 11); // "world"

    pasteInto(s, { 'text/plain': '# H\n\ntail' });

    const bs = blocks(s);
    expect(bs.map((b) => b.type)).toEqual(['paragraph', 'heading', 'paragraph']);
    expect(bs.map(text)).toEqual(['hello ', 'H', 'tail']);
  });
});

describe('defect 2 — paste into a container grafts instead of flattening', () => {
  it('multi-paragraph paste into a list item becomes sibling items (one per paragraph)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- item one\n- item two\n') });
    const li = container.querySelectorAll('li')[0]!;
    const leaf = li.querySelector('p') ?? li;
    caretIn(leaf.firstChild!, leaf.textContent!.length);

    pasteInto(s, { 'text/plain': 'para A\n\npara B' });

    const bs = blocks(s);
    expect(bs.map((b) => b.type), 'still a single list').toEqual(['bullet_list']);
    expect(itemTexts(bs[0]!)).toEqual(['item one', 'para A', 'para B', 'item two']);
  });

  it('pasted list content grafts as sibling items at the caret item', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- item one\n- item two\n') });
    const li = container.querySelectorAll('li')[0]!;
    const leaf = li.querySelector('p') ?? li;
    caretIn(leaf.firstChild!, leaf.textContent!.length);

    pasteInto(s, { 'text/plain': '- x\n- y' });

    expect(itemTexts(blocks(s)[0]!)).toEqual(['item one', 'x', 'y', 'item two']);
  });

  it('a single inline-only paragraph still merges inline (never opens a new item)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- item one\n- item two\n') });
    const li = container.querySelectorAll('li')[0]!;
    const leaf = li.querySelector('p') ?? li;
    caretIn(leaf.firstChild!, leaf.textContent!.length);

    pasteInto(s, { 'text/plain': ' EXTRA' });

    expect(itemTexts(blocks(s)[0]!)).toEqual(['item oneEXTRA', 'item two']);
  });

  it('multi-block paste into a blockquote joins the quote children', () => {
    const s = new BlockSurface({ container, doc: parseDocument('> quoted\n') });
    const bq = container.querySelector('blockquote')!;
    const leaf = bq.querySelector('p') ?? bq;
    caretIn(leaf.firstChild!, leaf.textContent!.length);

    pasteInto(s, { 'text/plain': 'para A\n\npara B' });

    const bs = blocks(s);
    expect(bs.map((b) => b.type)).toEqual(['blockquote']);
    const quote = bs[0]!;
    if (quote.type !== 'blockquote') throw new Error('not a blockquote');
    expect(quote.children.map(text), 'first pasted paragraph continues the line, the rest join as children').toEqual([
      'quotedpara A',
      'para B'
    ]);
  });

  it('a block a container cannot hold (a table) splits out AFTER the list', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- item one\n- item two\n') });
    const li = container.querySelectorAll('li')[0]!;
    const leaf = li.querySelector('p') ?? li;
    caretIn(leaf.firstChild!, leaf.textContent!.length);

    pasteInto(s, { 'text/plain': '| a | b |\n| - | - |\n| 1 | 2 |' });

    const bs = blocks(s);
    expect(bs.map((b) => b.type), 'table split out after the untouched list').toEqual(['bullet_list', 'table']);
    expect(itemTexts(bs[0]!)).toEqual(['item one', 'item two']);
  });
});

describe('defect 3 — paste never destroys or demotes the caret heading', () => {
  it('multi-paragraph paste at a heading start lands before the intact heading', () => {
    const s = new BlockSurface({ container, doc: parseDocument('# Title\n') });
    const h = container.querySelector('h1')!;
    caretIn(h.firstChild!, 0);

    pasteInto(s, { 'text/plain': 'para1\n\npara2' });

    const bs = blocks(s);
    expect(bs.map((b) => b.type), 'heading survives, blocks inserted before it').toEqual([
      'paragraph',
      'paragraph',
      'heading'
    ]);
    expect(bs.map(text), 'no "para2Title" word fusion').toEqual(['para1', 'para2', 'Title']);
    expect((bs[2] as Extract<BlockNode, { type: 'heading' }>).level).toBe(1);
  });

  it('inline-only paste mid-heading merges, keeping the heading identity', () => {
    const s = new BlockSurface({ container, doc: parseDocument('## Title\n') });
    const h = container.querySelector('h2')!;
    caretIn(h.firstChild!, 2); // "Ti|tle"

    pasteInto(s, { 'text/plain': 'X' });

    const bs = blocks(s);
    expect(bs.map((b) => b.type)).toEqual(['heading']);
    expect(text(bs[0]!)).toBe('TiXtle');
    expect((bs[0] as Extract<BlockNode, { type: 'heading' }>).level).toBe(2);
  });

  it('multi-block paste mid-heading keeps the tail as a heading, not a paragraph', () => {
    const s = new BlockSurface({ container, doc: parseDocument('# Heading\n') });
    const h = container.querySelector('h1')!;
    caretIn(h.firstChild!, 4); // "Head|ing"

    pasteInto(s, { 'text/plain': '- one\n- two' });

    const bs = blocks(s);
    expect(bs.map((b) => b.type), 'the heading head and tail stay headings around the list').toEqual([
      'heading',
      'bullet_list',
      'heading'
    ]);
    expect(bs.map(text)).toEqual(['Head', '', 'ing']);
  });
});

describe('defect 4 — inline HTML in pasted prose stays editable', () => {
  it('prose with an inline tag lands as an editable paragraph, tag rendered literally', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const p = container.querySelector('p')!;
    caretIn(p.firstChild!, 5);

    pasteInto(s, { 'text/plain': 'a <placeholder> mention' });

    const bs = blocks(s);
    expect(bs.map((b) => b.type), 'not a frozen block').toEqual(['paragraph']);
    expect(text(bs[0]!)).toBe('helloa <placeholder> mention');
  });

  it('the literal tag round-trips through a save + reload (escaped, still editable)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('start\n') });
    const p = container.querySelector('p')!;
    caretIn(p.firstChild!, p.textContent!.length);
    pasteInto(s, { 'text/plain': 'a <placeholder> b' });
    const md = serializeDocument(s.getDocument());
    expect(md, 'the < is escaped so a reparse cannot read it as an HTML tag').toContain('\\<placeholder>');
    const reloaded = parseDocument(md).blocks;
    expect(reloaded.map((b) => b.type), 'still a paragraph after a plain reload (no paste flag)').toEqual(['paragraph']);
    expect(text(reloaded[0]!)).toBe('starta <placeholder> b');
  });

  it('genuine block-level HTML still freezes on paste', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const p = container.querySelector('p')!;
    caretIn(p.firstChild!, 5);

    pasteInto(s, { 'text/plain': '<div>\n  <span>block</span>\n</div>' });

    expect(blocks(s).some((b) => b.type === 'frozen_block'), 'block HTML is preserved verbatim, not text-ified').toBe(true);
  });
});

describe('shared drop path benefits (SKR-165)', () => {
  it('an external drop of multi-block markdown into a list item grafts as siblings', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- item one\n- item two\n') });
    const li = container.querySelectorAll('li')[0]!;
    const leaf = li.querySelector('p') ?? li;
    const tn = leaf.firstChild!;
    (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = () => ({
      offsetNode: tn,
      offset: tn.textContent!.length
    });
    const e = {
      clientX: 10,
      clientY: 10,
      dataTransfer: transfer({ 'text/plain': '- x\n- y' }),
      preventDefault() {}
    } as unknown as Event;

    priv(s).onDrop(e);

    expect(itemTexts(blocks(s)[0]!)).toEqual(['item one', 'x', 'y', 'item two']);
  });
});
