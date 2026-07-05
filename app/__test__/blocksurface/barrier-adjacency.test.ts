// @vitest-environment jsdom
//
// Backspace/Delete adjacent to a barrier (SKR-167 / F44). mergeBackward /
// mergeForward return null when the merge neighbor is a barrier — a divider,
// code block, or table — and until this fix the callers silently dropped that
// null: Backspace at the start of a block after a divider (or Delete at the
// end of one before it) did nothing, making a leading divider undeletable.
//
// The fix branches on what the neighbor is: an hr carries no content, so it is
// deleted outright in one gesture / one undo step; a code block or table is
// content-bearing, so it is selected as a unit instead (SKR-203's substrate) —
// first Backspace/Delete selects, a second deletes, Notion's convention.
//
// jsdom models enough Selection/Range for the surface's leafTarget /
// readSelection to run against a real DOM; applyDeleteBackward/Forward are
// invoked directly (as barrier-selection.test.ts does) since jsdom does not
// dispatch real beforeinput events for a simulated Backspace/Delete key.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const CODE = '```\ncode\n```';
const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';
const plain = (inline: InlineNode[]): string => inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');

function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}
function backspace(surface: BlockSurface): void {
  (surface as unknown as { applyDeleteBackward: () => void }).applyDeleteBackward();
}
function deleteForward(surface: BlockSurface): void {
  (surface as unknown as { applyDeleteForward: () => void }).applyDeleteForward();
}
function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
  return e;
}
function selectedIds(surface: BlockSurface): readonly string[] {
  return surface.getSelectedBlockIds();
}
function blocksOf(surface: BlockSurface): BlockNode[] {
  return surface.getDocument().blocks;
}
function paragraphText(surface: BlockSurface, needle: string): string {
  const p = blocksOf(surface).find(
    (b) => (b.type === 'paragraph' || b.type === 'heading') && plain(b.inline).startsWith(needle)
  );
  if (!p || (p.type !== 'paragraph' && p.type !== 'heading')) throw new Error(`no paragraph starting "${needle}"`);
  return plain(p.inline);
}
function idOfParagraph(surface: BlockSurface, text: string): string {
  const p = blocksOf(surface).find((b) => (b.type === 'paragraph' || b.type === 'heading') && plain(b.inline) === text);
  if (!p) throw new Error(`no paragraph "${text}"`);
  return p.id;
}
function idOf(surface: BlockSurface, type: BlockNode['type']): string {
  const b = blocksOf(surface).find((b) => b.type === type);
  if (!b) throw new Error(`no ${type}`);
  return b.id;
}
function countOf(surface: BlockSurface, type: BlockNode['type']): number {
  return blocksOf(surface).filter((b) => b.type === type).length;
}

describe('Backspace at the start of a block after a divider', () => {
  it('deletes the divider in one gesture; the caret stays put', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('a\n\n---\n\nb\n') });
    const b = container.querySelectorAll('p')[1]!;
    caretIn(b.firstChild!, 0);

    backspace(surface);

    expect(countOf(surface, 'horizontal_rule')).toBe(0);
    expect(paragraphText(surface, 'a')).toBe('a');
    expect(paragraphText(surface, 'b')).toBe('b');
    const t = (surface as unknown as { leafTarget: () => { leaf: BlockNode; start: number } | null }).leafTarget();
    expect(t?.leaf.type).toBe('paragraph');
    expect(t?.start, 'caret stays at the start of the current block').toBe(0);
  });

  it('undo restores the divider', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('a\n\n---\n\nb\n') });
    const b = container.querySelectorAll('p')[1]!;
    caretIn(b.firstChild!, 0);

    backspace(surface);
    expect(countOf(surface, 'horizontal_rule')).toBe(0);

    surface.undo();
    expect(countOf(surface, 'horizontal_rule'), 'one undo restores it').toBe(1);
  });

  it('a leading divider (first block of the doc) is deletable', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('---\n\nb\n') });
    const b = container.querySelector('p')!;
    caretIn(b.firstChild!, 0);

    backspace(surface);

    expect(countOf(surface, 'horizontal_rule')).toBe(0);
    expect(blocksOf(surface).map((x) => x.type)).toEqual(['paragraph']);
    expect(paragraphText(surface, 'b')).toBe('b');
  });
});

describe('Delete-forward at the end of a block before a divider', () => {
  it('deletes the divider in one gesture; the caret stays put', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('a\n\n---\n\nb\n') });
    const a = container.querySelectorAll('p')[0]!;
    caretIn(a.firstChild!, 1);

    deleteForward(surface);

    expect(countOf(surface, 'horizontal_rule')).toBe(0);
    expect(paragraphText(surface, 'a')).toBe('a');
    expect(paragraphText(surface, 'b')).toBe('b');
    const t = (surface as unknown as { leafTarget: () => { leaf: BlockNode; start: number } | null }).leafTarget();
    expect(t?.leaf.type).toBe('paragraph');
    expect(t?.start, 'caret stays at the end of the current block').toBe(1);
  });
});

describe('Adjacent dividers: only the nearest is deleted per gesture', () => {
  it('one Backspace removes the nearer divider, leaving the farther one and the surrounding prose intact', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('a\n\n---\n\n---\n\nb\n') });
    const b = container.querySelectorAll('p')[1]!;
    caretIn(b.firstChild!, 0);

    backspace(surface);

    expect(countOf(surface, 'horizontal_rule'), 'only one divider removed').toBe(1);
    expect(paragraphText(surface, 'a')).toBe('a');
    expect(paragraphText(surface, 'b')).toBe('b');

    // A second Backspace (caret still at the start of "b") removes the other one.
    backspace(surface);
    expect(countOf(surface, 'horizontal_rule')).toBe(0);
    expect(paragraphText(surface, 'a')).toBe('a');
    expect(paragraphText(surface, 'b')).toBe('b');
  });
});

describe('Backspace/Delete next to a code block or table selects it instead of no-opping', () => {
  it('Backspace at the start of a block after a code block selects the code block, leaving it untouched', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${CODE}\n\nb\n`) });
    const b = container.querySelector('p')!;
    caretIn(b.firstChild!, 0);
    const codeId = idOf(surface, 'code_block');

    backspace(surface);

    expect(selectedIds(surface)).toEqual([codeId]);
    expect(container.querySelector('pre')!.hasAttribute('data-block-selected')).toBe(true);
    // The model is untouched: the code block still holds its text, "b" still there.
    const code = blocksOf(surface).find((x) => x.id === codeId);
    expect(code && code.type === 'code_block' && code.text).toBe('code');
    expect(paragraphText(surface, 'b')).toBe('b');
  });

  it('Delete-forward at the end of a block before a table selects the table, leaving it untouched', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`a\n\n${TABLE}\n`) });
    const a = container.querySelector('p')!;
    caretIn(a.firstChild!, 1);
    const tableId = idOf(surface, 'table');

    deleteForward(surface);

    expect(selectedIds(surface)).toEqual([tableId]);
    expect(container.querySelector('table')!.hasAttribute('data-block-selected')).toBe(true);
    const table = blocksOf(surface).find((x) => x.id === tableId);
    expect(table && table.type === 'table' && table.rows.length).toBe(2);
    expect(paragraphText(surface, 'a')).toBe('a');
  });

  it('a second Backspace after the select deletes the barrier (the two-step Notion flow)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${CODE}\n\nb\n`) });
    const b = container.querySelector('p')!;
    caretIn(b.firstChild!, 0);

    backspace(surface); // first Backspace: selects
    expect(selectedIds(surface)).not.toEqual([]);

    key(surface, { key: 'Backspace' }); // second Backspace: routes through handleBlockSelectionKey

    expect(blocksOf(surface).find((x) => x.type === 'code_block'), 'code block deleted').toBeUndefined();
    expect(selectedIds(surface)).toEqual([]);
    expect(paragraphText(surface, 'b')).toBe('b');
  });
});

describe('Container boundary: blockquote (in scope, same mergeBackward codepath)', () => {
  it('Backspace at the start of a blockquote paragraph after a divider deletes the divider', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('---\n\n> b\n') });
    const b = container.querySelector('blockquote p')!;
    caretIn(b.firstChild!, 0);

    backspace(surface);

    expect(countOf(surface, 'horizontal_rule')).toBe(0);
    const quote = blocksOf(surface).find((x) => x.type === 'blockquote');
    expect(quote && quote.type === 'blockquote' && quote.children[0]!.type === 'paragraph' && plain(quote.children[0]!.inline)).toBe('b');
  });
});

describe('Container boundary: list items (out of scope — Backspace-at-start outdents, never reaches mergeBackward)', () => {
  it('Backspace at the start of a list item after a divider is untouched by this fix', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('---\n\n- b\n') });
    const item = container.querySelector('li')!;
    caretIn(item.firstChild!, 0);

    backspace(surface);

    // Whatever applyOutdent does to a top-level item (a no-op, since there's
    // nothing to outdent to) is pre-existing, unrelated behaviour: the point
    // here is that the divider is left alone and nothing gets selected.
    expect(countOf(surface, 'horizontal_rule'), 'divider is not this fix\'s concern for list items').toBe(1);
    expect(selectedIds(surface)).toEqual([]);
  });
});
