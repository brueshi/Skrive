// @vitest-environment jsdom
//
// Pending marks + caret-context affordances (SKR-177 / F62, F64). ⌘B/I/E at a
// collapsed caret primes a mark the next typed text carries (Docs-style); the
// summary reports the caret's mark/link context so the toolbar and Link control
// work from a bare caret; ⌘K opens the link editor.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 1, height: 1, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});
afterEach(() => container.remove());

type Driver = { applyInsertText: (t: string) => void; emitSelection: () => void; onKeyDown: (e: Event) => void };
const drive = (s: BlockSurface): Driver => s as unknown as Driver;

function collapse(node: Node, offset: number): void {
  window.getSelection()!.collapse(node, offset);
}
function firstParagraph(surface: BlockSurface): Extract<BlockNode, { type: 'paragraph' }> {
  const p = surface.getDocument().blocks.find((b): b is Extract<BlockNode, { type: 'paragraph' }> => b.type === 'paragraph');
  if (!p) throw new Error('no paragraph');
  return p;
}
function inlineOf(surface: BlockSurface) {
  return firstParagraph(surface).inline;
}
function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  drive(surface).onKeyDown(e);
  return e;
}

describe('pending marks (⌘B/I/E at a collapsed caret)', () => {
  it('primes a mark the next typed character carries', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hi\n') });
    collapse(container.querySelector('p')!.firstChild!, 2);
    surface.toggleMark('strong');
    drive(surface).applyInsertText('X');

    const inline = inlineOf(surface);
    // "hi" stays plain; the primed "X" is its own bold run.
    expect(inline.map((n) => (n.kind === 'text' ? n.text : n.kind))).toEqual(['hi', 'X']);
    expect(inline[1]).toMatchObject({ text: 'X', marks: { strong: true } });
  });

  it('a second toggle at the same caret cancels the pending mark', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hi\n') });
    collapse(container.querySelector('p')!.firstChild!, 2);
    surface.toggleMark('strong');
    surface.toggleMark('strong'); // back off
    drive(surface).applyInsertText('X');

    const inline = inlineOf(surface);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ text: 'hiX' });
    expect(inline[0]!.marks.strong).toBeFalsy();
  });

  it('clears the pending mark when the caret moves before typing', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hi\n') });
    const tn = container.querySelector('p')!.firstChild!;
    collapse(tn, 2);
    surface.toggleMark('strong'); // primed at offset 2

    collapse(tn, 0); // move the caret
    drive(surface).emitSelection(); // the selection observer clears the primed mark

    collapse(tn, 0);
    drive(surface).applyInsertText('X');
    const inline = inlineOf(surface);
    expect(inline).toHaveLength(1);
    expect(inline[0]!.marks.strong).toBeFalsy();
  });

  it('the summary reflects a primed mark on a collapsed caret', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hi\n') });
    collapse(container.querySelector('p')!.firstChild!, 2);
    surface.toggleMark('strong');
    const info = surface.getSelectionInfo();
    expect(info?.empty).toBe(true);
    expect(info?.marks.strong).toBe(true);
  });
});

describe('caret-context mark + link state', () => {
  it('reports the mark of the run the collapsed caret sits in', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('**ab**\n') });
    const strongEl = container.querySelector('strong')!;
    collapse(strongEl.firstChild!, 1); // inside the bold run
    const info = surface.getSelectionInfo();
    expect(info?.marks.strong).toBe(true);
  });

  it('reports the link a collapsed caret sits inside, and beginLink expands to it', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('[here](https://x.test)\n') });
    collapse(container.querySelector('a')!.firstChild!, 2); // inside "here"
    const info = surface.getSelectionInfo();
    expect(info?.marks.link).toBe(true);
    expect(info?.linkHref).toBe('https://x.test');
    expect(surface.beginLink()).toBe(true); // actionable from a bare caret
  });

  it('a bare caret outside any link cannot begin a link', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hi\n') });
    collapse(container.querySelector('p')!.firstChild!, 1);
    expect(surface.beginLink()).toBe(false);
  });
});

describe('⌘K', () => {
  it('requests the link editor and consumes the key', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hi\n') });
    let requested = 0;
    surface.onRequestLinkEditor(() => {
      requested++;
    });
    const e = key(surface, { code: 'KeyK', key: 'k', metaKey: true });
    expect(requested).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });
});
