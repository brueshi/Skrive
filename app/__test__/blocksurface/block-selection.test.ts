// @vitest-environment jsdom
//
// Block selection (SKR-203): selecting a code block / table as a UNIT and acting
// on it as an object. Escape (and the ⌘A block step) select the whole block;
// Backspace / Delete remove it in one history step; typing replaces it with a
// paragraph; arrows / Escape-again / a click dissolve it back to a text caret.
// The state is authoritative surface state, not derived from the DOM selection —
// these drive the real keydown routing so the escalation and dissolution paths are
// pinned end to end. jsdom models enough Selection/Range for cellTarget /
// leafTarget / readSelection / setCaret to run against a real DOM.

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
// A raw HTML block is the frozen_block case (SKR-216): there is no image *block*
// in the model (an image is an InlineNode inside a paragraph), so frozen_block is
// the only other content-bearing barrier this substrate needed wiring for.
const FROZEN = '<div>raw</div>';
const plain = (inline: InlineNode[]): string => inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');

function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}
function selectDom(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  sel.addRange(range);
}
function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
  return e;
}
function selectedIds(surface: BlockSurface): readonly string[] {
  return surface.getSelectedBlockIds();
}
function blockOf(surface: BlockSurface, type: BlockNode['type']): BlockNode | undefined {
  return surface.getDocument().blocks.find((b) => b.type === type);
}
function idOf(surface: BlockSurface, type: BlockNode['type']): string {
  const b = blockOf(surface, type);
  if (!b) throw new Error(`no ${type}`);
  return b.id;
}
function codeText(el: HTMLElement): Node {
  // The addressable text position inside a code block lives in its <code> child.
  return (el.querySelector('code') ?? el).firstChild!;
}

describe('Escape selects the enclosing barrier block', () => {
  it('inside a code block selects that block', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    const pre = container.querySelector('pre')!;
    caretIn(codeText(pre), 2);

    const e = key(surface, { key: 'Escape' });

    expect(e.defaultPrevented).toBe(true);
    expect(selectedIds(surface)).toEqual([idOf(surface, 'code_block')]);
    expect(pre.hasAttribute('data-block-selected')).toBe(true);
  });

  it('inside a table cell selects the table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const cell = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')!;
    caretIn(cell.firstChild!, 0);

    key(surface, { key: 'Escape' });

    expect(selectedIds(surface)).toEqual([idOf(surface, 'table')]);
    expect(container.querySelector('table')!.hasAttribute('data-block-selected')).toBe(true);
  });

  it('in prose does nothing new', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    const p = container.querySelector('p')!;
    caretIn(p.firstChild!, 2);

    const e = key(surface, { key: 'Escape' });

    expect(e.defaultPrevented).toBe(false);
    expect(selectedIds(surface)).toEqual([]);
  });
});

describe('Backspace / Delete on a selected block', () => {
  it('removes the block in one history step and lands the caret on an inline neighbour', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    caretIn(codeText(container.querySelector('pre')!), 1);
    key(surface, { key: 'Escape' });

    key(surface, { key: 'Backspace' });

    expect(blockOf(surface, 'code_block'), 'code block removed').toBeUndefined();
    expect(selectedIds(surface), 'selection cleared').toEqual([]);
    const t = (surface as unknown as { leafTarget: () => { leaf: BlockNode; start: number } | null }).leafTarget();
    expect(t?.leaf.type).toBe('paragraph');
    expect(t?.start, 'caret at end of the previous prose').toBe('hello'.length);

    surface.undo();
    expect(blockOf(surface, 'code_block'), 'one undo restores the block').toBeTruthy();
    expect(selectedIds(surface)).toEqual([]);
  });

  it('seeds a paragraph when deleting the block empties the document', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${CODE}\n`) });
    caretIn(codeText(container.querySelector('pre')!), 0);
    key(surface, { key: 'Escape' });

    key(surface, { key: 'Delete' });

    const blocks = surface.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(blocks[0]!.type === 'paragraph' && plain(blocks[0]!.inline)).toBe('');
  });

  it('deletes a selected table', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hi\n\n${TABLE}\n`) });
    caretIn(container.querySelector('[data-cell-row="0"][data-cell-col="0"]')!.firstChild!, 0);
    key(surface, { key: 'Escape' });

    key(surface, { key: 'Backspace' });

    expect(blockOf(surface, 'table')).toBeUndefined();
    expect(blockOf(surface, 'paragraph')).toBeTruthy();
  });
});

// SKR-192: word/line delete chords used to be a silent no-op on a selected block —
// handleBlockSelectionKey let any modified Backspace/Delete fall through to the
// normal handler, and with the DOM selection cleared (SKR-203) there was nothing
// left for the browser's native delete to act on. They now act on the selection
// exactly like plain Backspace/Delete, one history step.
describe('Word / line delete on a selected block', () => {
  it('Option+Backspace (deleteWordBackward) deletes the selected code block in one step; undo restores it', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    caretIn(codeText(container.querySelector('pre')!), 1);
    key(surface, { key: 'Escape' });

    const e = key(surface, { key: 'Backspace', altKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(blockOf(surface, 'code_block'), 'code block removed').toBeUndefined();
    expect(selectedIds(surface), 'selection cleared').toEqual([]);

    surface.undo();
    expect(blockOf(surface, 'code_block'), 'one undo restores the block').toBeTruthy();
  });

  it('Cmd+Backspace (deleteSoftLineBackward/deleteHardLineBackward) deletes the selected table in one step; undo restores it', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hi\n\n${TABLE}\n`) });
    caretIn(container.querySelector('[data-cell-row="0"][data-cell-col="0"]')!.firstChild!, 0);
    key(surface, { key: 'Escape' });

    const e = key(surface, { key: 'Backspace', metaKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(blockOf(surface, 'table'), 'table removed').toBeUndefined();
    expect(selectedIds(surface), 'selection cleared').toEqual([]);

    surface.undo();
    expect(blockOf(surface, 'table'), 'one undo restores the table').toBeTruthy();
  });

  it('forward variant (Option/Cmd+Delete) deletes the selected block the same way', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    caretIn(codeText(container.querySelector('pre')!), 1);
    key(surface, { key: 'Escape' });

    const e = key(surface, { key: 'Delete', altKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(blockOf(surface, 'code_block'), 'code block removed').toBeUndefined();

    surface.undo();
    expect(blockOf(surface, 'code_block'), 'one undo restores the block').toBeTruthy();
  });
});

describe('Typing over a selected block', () => {
  it('replaces it with a paragraph containing the typed character; one undo restores the block', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${CODE}\n`) });
    const codeId = idOf(surface, 'code_block');
    caretIn(codeText(container.querySelector('pre')!), 1);
    key(surface, { key: 'Escape' });

    key(surface, { key: 'x' });

    const blocks = surface.getDocument().blocks;
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.type).toBe('paragraph');
    expect(blocks[0]!.type === 'paragraph' && plain(blocks[0]!.inline)).toBe('x');
    expect(blocks[0]!.id, 'reuses the block id + seam').toBe(codeId);
    expect(selectedIds(surface)).toEqual([]);

    surface.undo();
    expect(blockOf(surface, 'code_block'), 'one undo restores the code block').toBeTruthy();
  });
});

describe('⌘A escalation inside a barrier', () => {
  it('code block: leaf text -> whole block -> document', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    const pre = container.querySelector('pre')!;
    caretIn(codeText(pre), 2);

    // 1: select the leaf's text.
    key(surface, { key: 'a', metaKey: true });
    expect(selectedIds(surface)).toEqual([]);
    expect(window.getSelection()!.toString()).toBe('code');

    // 2: select the whole block.
    key(surface, { key: 'a', metaKey: true });
    expect(selectedIds(surface)).toEqual([idOf(surface, 'code_block')]);

    // 3: select the document (ring dissolves, whole surface selected).
    key(surface, { key: 'a', metaKey: true });
    expect(selectedIds(surface)).toEqual([]);
    const sel = window.getSelection()!;
    expect(sel.isCollapsed).toBe(false);
    expect(sel.toString()).toContain('hello');
  });

  it('table cell: leaf text -> whole block -> document', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const cell = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')! as HTMLElement;
    caretIn(cell.firstChild!, 1);

    key(surface, { key: 'a', metaKey: true });
    expect(selectedIds(surface)).toEqual([]);
    expect(window.getSelection()!.toString()).toBe('1');

    key(surface, { key: 'a', metaKey: true });
    expect(selectedIds(surface)).toEqual([idOf(surface, 'table')]);

    key(surface, { key: 'a', metaKey: true });
    expect(selectedIds(surface)).toEqual([]);
    expect(window.getSelection()!.isCollapsed).toBe(false);
  });

  it('leaves ⌘A in prose to the browser (no escalation)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    caretIn(container.querySelector('p')!.firstChild!, 1);

    const e = key(surface, { key: 'a', metaKey: true });

    expect(e.defaultPrevented, 'native select-all not intercepted in prose').toBe(false);
    expect(selectedIds(surface)).toEqual([]);
  });
});

describe('Dissolving a block selection', () => {
  it('ArrowUp/Left lands the caret before the block (end of the previous inline leaf)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    caretIn(codeText(container.querySelector('pre')!), 1);
    key(surface, { key: 'Escape' });

    key(surface, { key: 'ArrowUp' });

    expect(selectedIds(surface)).toEqual([]);
    const t = (surface as unknown as { leafTarget: () => { leaf: BlockNode; start: number } | null }).leafTarget();
    expect(t?.leaf.type).toBe('paragraph');
    expect(t?.start).toBe('hello'.length);
  });

  it('ArrowDown/Right lands the caret after the block', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n\nbye\n`) });
    caretIn(codeText(container.querySelector('pre')!), 1);
    key(surface, { key: 'Escape' });

    key(surface, { key: 'ArrowRight' });

    expect(selectedIds(surface)).toEqual([]);
    const t = (surface as unknown as { leafTarget: () => { leaf: BlockNode; start: number } | null }).leafTarget();
    expect(t?.leaf.type).toBe('paragraph');
    expect(t?.start, 'start of the next prose').toBe(0);
  });

  it('Escape again dissolves back to a caret', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    caretIn(codeText(container.querySelector('pre')!), 1);
    key(surface, { key: 'Escape' });
    expect(selectedIds(surface)).not.toEqual([]);

    key(surface, { key: 'Escape' });

    expect(selectedIds(surface)).toEqual([]);
    expect(container.querySelector('[data-block-selected]')).toBeNull();
  });

  it('a user DOM selection (a click) dissolves it via the observer, without touching a self-cleared selection', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${CODE}\n`) });
    caretIn(codeText(container.querySelector('pre')!), 1);
    key(surface, { key: 'Escape' });

    // The observer must NOT dissolve on our own removeAllRanges (rangeCount 0).
    (surface as unknown as { dissolveOnUserSelection: () => void }).dissolveOnUserSelection();
    expect(selectedIds(surface), 'self-inflicted clear ignored').not.toEqual([]);

    // A real caret placed by the user (a click) dissolves it, caret left in place.
    caretIn(container.querySelector('p')!.firstChild!, 3);
    (surface as unknown as { dissolveOnUserSelection: () => void }).dissolveOnUserSelection();
    expect(selectedIds(surface)).toEqual([]);
    expect(container.querySelector('[data-block-selected]')).toBeNull();
  });
});

// Frozen blocks (SKR-216): rendered contentEditable=false (see render.ts), so
// there is no caret to place inside one — Escape / ⌘A escalation (which key off
// a caret already being inside the barrier) don't apply. Click is the only entry
// point besides the Backspace/Delete adjacency gesture covered in
// barrier-adjacency.test.ts.
describe('Click on a frozen block selects it as a unit (SKR-216)', () => {
  function click(target: Element): void {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  it('selects the frozen block and paints the ring', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${FROZEN}\n`) });
    const frozenEl = container.querySelector('[data-frozen]')!;
    // Never editable in place: the browser can't plant a caret inside it.
    expect((frozenEl as HTMLElement).contentEditable).toBe('false');

    click(frozenEl);

    expect(selectedIds(surface)).toEqual([idOf(surface, 'frozen_block')]);
    expect(frozenEl.hasAttribute('data-block-selected')).toBe(true);
  });

  it('clicking a child of the frozen block still selects the whole block', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${FROZEN}\n`) });
    const frozenEl = container.querySelector('[data-frozen]')!;

    click(frozenEl.firstChild as unknown as Element);

    expect(selectedIds(surface)).toEqual([idOf(surface, 'frozen_block')]);
  });

  it('a subsequent click into prose dissolves the selection', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${FROZEN}\n`) });
    click(container.querySelector('[data-frozen]')!);
    expect(selectedIds(surface)).not.toEqual([]);

    // A real caret landing in prose (what a click there resolves to) dissolves
    // the ring via the same observer as every other block selection.
    caretIn(container.querySelector('p')!.firstChild!, 2);
    (surface as unknown as { dissolveOnUserSelection: () => void }).dissolveOnUserSelection();

    expect(selectedIds(surface)).toEqual([]);
    expect(container.querySelector('[data-block-selected]')).toBeNull();
  });
});
