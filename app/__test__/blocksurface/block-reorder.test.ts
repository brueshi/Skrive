// @vitest-environment jsdom
//
// The surface half of grip drag-to-reorder: moveBlockBefore, insertBlockAbove and
// the block selection-change channel the chrome paints off. These assert what the
// writer ends up SEEING as well as what the model holds — a reorder that got the
// model right and left the DOM stale would be invisible to a serialization-only
// assertion, which is exactly how a repaint bug hides.
//
// The drop is expressed as "before which block" rather than as an index because
// the visible order is not the model's: footnote definitions are gathered into a
// generated document-end footer. The footnote case below is the one that pins it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const plain = (inline: InlineNode[]): string => inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');

function surfaceFor(md: string): BlockSurface {
  return new BlockSurface({ container, doc: parseDocument(md) });
}
/** Top-level block text in MODEL order. */
function model(s: BlockSurface): string[] {
  return s.getDocument().blocks.map((b) => (b.type === 'paragraph' || b.type === 'heading' ? plain(b.inline) : b.type));
}
/** Top-level block text as PAINTED, in DOM order. */
function painted(): string[] {
  return Array.from(container.querySelectorAll(':scope > [data-block-id]')).map((el) => el.textContent ?? '');
}
function idOf(s: BlockSurface, text: string): string {
  const b = s.getDocument().blocks.find((x) => (x.type === 'paragraph' || x.type === 'heading') && plain(x.inline) === text);
  if (!b) throw new Error(`no top-level block: ${text}`);
  return b.id;
}

describe('moveBlockBefore', () => {
  it('moves a block above another, in the model and on screen', () => {
    const s = surfaceFor('a\n\nb\n\nc\n');
    s.moveBlockBefore(idOf(s, 'c'), idOf(s, 'a'));
    expect(model(s)).toEqual(['c', 'a', 'b']);
    expect(painted()).toEqual(['c', 'a', 'b']);
  });

  it('moves a block to the end when the target is null', () => {
    const s = surfaceFor('a\n\nb\n\nc\n');
    s.moveBlockBefore(idOf(s, 'a'), null);
    expect(model(s)).toEqual(['b', 'c', 'a']);
    expect(painted()).toEqual(['b', 'c', 'a']);
  });

  it('no-ops when the block is already there, earning no undo step', () => {
    const s = surfaceFor('a\n\nb\n\nc\n');
    const before = s.getDocument();
    s.moveBlockBefore(idOf(s, 'b'), idOf(s, 'c')); // b already sits before c
    expect(s.getDocument(), 'the doc object is untouched').toBe(before);
  });

  it('no-ops on an unknown target rather than moving to the end', () => {
    const s = surfaceFor('a\n\nb\n');
    const before = s.getDocument();
    s.moveBlockBefore(idOf(s, 'a'), 'nope');
    expect(s.getDocument()).toBe(before);
  });

  it('survives undo as a single step, restoring both model and paint', () => {
    const s = surfaceFor('a\n\nb\n\nc\n');
    s.moveBlockBefore(idOf(s, 'c'), idOf(s, 'a'));
    expect(painted()).toEqual(['c', 'a', 'b']);
    s.undo();
    expect(model(s), 'one undo restores the original order').toEqual(['a', 'b', 'c']);
    expect(painted(), 'and the DOM repaints with it').toEqual(['a', 'b', 'c']);
  });

  it('addresses the model, not the screen, when a footnote definition is gathered', () => {
    // The definition is authored in the middle but DISPLAYS in the footer, so the
    // model index of `tail` and its on-screen position disagree. Moving `tail`
    // above `intro` must use the id, or the block lands beside the definition.
    const s = surfaceFor('intro[^1]\n\n[^1]: note\n\ntail\n');
    expect(model(s)).toEqual(['intro', 'footnote_definition', 'tail']);
    expect(painted()[2], 'the definition paints LAST, after tail').toContain('note');

    s.moveBlockBefore(idOf(s, 'tail'), idOf(s, 'intro'));
    expect(model(s)).toEqual(['tail', 'intro', 'footnote_definition']);
    // `intro` paints its reference marker too, so match the prefix rather than
    // the exact text.
    expect(painted()[0]).toBe('tail');
    expect(painted()[1]).toMatch(/^intro/);
  });
});

describe('insertBlockAbove', () => {
  it('inserts an empty paragraph above and paints it', () => {
    const s = surfaceFor('a\n\nb\n');
    s.insertBlockAbove(idOf(s, 'b'));
    expect(model(s)).toEqual(['a', '', 'b']);
    expect(painted().length).toBe(3);
  });

  it('is one undo step', () => {
    const s = surfaceFor('a\n\nb\n');
    s.insertBlockAbove(idOf(s, 'b'));
    s.undo();
    expect(model(s)).toEqual(['a', 'b']);
    expect(painted()).toEqual(['a', 'b']);
  });

  it('no-ops on an unknown block', () => {
    const s = surfaceFor('a\n');
    const before = s.getDocument();
    s.insertBlockAbove('nope');
    expect(s.getDocument()).toBe(before);
  });
});

describe('block selection channel', () => {
  it('notifies on select and on clear, so the grip can stay lit', () => {
    const s = surfaceFor('a\n\nb\n');
    let notifications = 0;
    const off = s.onBlockSelectionChange(() => notifications++);

    s.selectBlockAt(idOf(s, 'a'));
    expect(notifications).toBe(1);
    expect(s.getSelectedBlockIds()).toEqual([idOf(s, 'a')]);

    off();
    s.selectBlockAt(idOf(s, 'b'));
    expect(notifications, 'unsubscribed').toBe(1);
  });

  it('clears the selection when a block is inserted above', () => {
    const s = surfaceFor('a\n\nb\n');
    s.selectBlockAt(idOf(s, 'b'));
    expect(s.getSelectedBlockIds().length).toBe(1);
    s.insertBlockAbove(idOf(s, 'b'));
    expect(s.getSelectedBlockIds(), 'the caret moved to the new block').toEqual([]);
  });
});
