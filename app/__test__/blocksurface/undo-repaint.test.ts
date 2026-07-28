// @vitest-environment jsdom
//
// Undo has to repaint, not just restore.
//
// Every existing undo assertion in this suite compares the serialized MODEL, and
// the model was never the problem: a mid-paragraph Enter followed by one undo
// restored the document perfectly while the screen kept showing the truncated
// left half, so the tail of the writer's paragraph simply vanished. Nothing was
// lost on disk, but "my text disappeared" is indistinguishable from data loss at
// the moment it happens.
//
// The cause is bookkeeping, not rendering. Reconcile skips a block whose model
// object is identical to the one `renderedFrom` recorded, which is what keeps
// typing cheap. The Enter fast path rewrote the left half's DOM surgically
// (renderInlineInto) without updating that record, so `renderedFrom` still
// pointed at the PRE-split object — the very object undo restores. Reconcile
// then compared the restored object against itself, concluded nothing had
// changed, and left the stale DOM alone.
//
// These tests therefore assert the DOM alongside the model. A model-only
// assertion passes on the bug.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../jsdom-range-rect';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}

function pressEnter(surface: BlockSurface): void {
  const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
}

/** What the writer actually sees: the text of each rendered top-level block. */
const painted = (): string[] =>
  Array.from(container.querySelectorAll('[data-block-id]')).map((el) => el.textContent ?? '');

/** What the document holds: the text of each top-level inline-text block. */
const modelled = (surface: BlockSurface): string[] =>
  surface.getDocument().blocks.map((b) => {
    const inline = (b as unknown as { inline?: { kind: string; text?: string }[] }).inline;
    return (inline ?? []).map((n) => (n.kind === 'text' ? (n.text ?? '') : '')).join('');
  });

describe('undo after a mid-paragraph split', () => {
  it('puts the restored text back on screen, not just in the model', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('Notes toward a method\n') });
    const textNode = container.querySelector('p')!.firstChild!;

    caretIn(textNode, 'Notes toward'.length);
    pressEnter(surface);
    expect(modelled(surface), 'the paragraph split').toEqual(['Notes toward', ' a method']);
    expect(painted(), 'both halves are on screen').toEqual(['Notes toward', ' a method']);

    surface.undo();
    expect(modelled(surface), 'the model rejoined').toEqual(['Notes toward a method']);
    // The assertion that was missing: before the fix this read ['Notes toward'],
    // so " a method" was in the document but nowhere on screen.
    expect(painted(), 'the screen rejoined too').toEqual(['Notes toward a method']);
  });

  it('redo re-splits on screen as well', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('Notes toward a method\n') });
    caretIn(container.querySelector('p')!.firstChild!, 'Notes toward'.length);
    pressEnter(surface);
    surface.undo();
    surface.redo();

    expect(modelled(surface)).toEqual(['Notes toward', ' a method']);
    expect(painted(), 'the split is painted again').toEqual(['Notes toward', ' a method']);
  });

  it('holds for a split at the very end of a paragraph', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('Notes toward a method\n') });
    const text = 'Notes toward a method';
    caretIn(container.querySelector('p')!.firstChild!, text.length);
    pressEnter(surface);
    expect(painted()).toEqual([text, '']);

    surface.undo();
    expect(modelled(surface)).toEqual([text]);
    expect(painted(), 'the trailing empty block went with it').toEqual([text]);
  });
});
