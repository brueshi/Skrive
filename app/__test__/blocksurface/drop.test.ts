// @vitest-environment jsdom
//
// Text drag-and-drop (SKR-165 / F81). External text dropped from another app
// lands at the drop point through the same interpretation pipeline as paste;
// internal drags (a selection dragged within the doc) are refused honestly
// (dropEffect 'none') rather than silently doing nothing.
//
// jsdom implements no caret-from-point API, so the drop-point resolver returns
// null there — the real point->position mapping is Playwright / shell only. These
// tests stub caretPositionFromPoint / caretRangeFromPoint to exercise the resolver
// wrapper and the landing pipeline; the note above records the shell-only gap.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';
import { inlinePlainText } from '../../src/lib/blocksurface/inline-ops';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
  delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
  delete (document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
});

type Priv = {
  resolveCaretPoint: (x: number, y: number) => { node: Node; offset: number } | null;
  placeCaretAtPoint: (p: { node: Node; offset: number }) => boolean;
  onDragStart: () => void;
  onDragOver: (e: Event) => void;
  onDrop: (e: Event) => void;
  onDragEnd: () => void;
};
const priv = (s: BlockSurface) => s as unknown as Priv;

function transfer(map: Record<string, string>): DataTransfer {
  return { getData: (type: string) => map[type] ?? '' } as unknown as DataTransfer;
}
function dropEvent(x: number, y: number, data: DataTransfer): Event & { defaulted: boolean } {
  const e = { clientX: x, clientY: y, dataTransfer: data, defaulted: false, preventDefault() { e.defaulted = true; } };
  return e as unknown as Event & { defaulted: boolean };
}
function blocksOf(s: BlockSurface): BlockNode[] {
  return s.getDocument().blocks;
}
function paraText(s: BlockSurface): string {
  const p = blocksOf(s).find((b) => b.type === 'paragraph' || b.type === 'heading');
  if (!p || (p.type !== 'paragraph' && p.type !== 'heading')) throw new Error('no paragraph');
  return inlinePlainText(p.inline);
}

// Point the caret resolver at a fixed DOM node+offset (jsdom has no real one).
function stubCaret(node: Node, offset: number): void {
  (document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = () => ({ offsetNode: node, offset });
}

describe('resolveCaretPoint wrapper', () => {
  it('returns null when the platform offers no caret-from-point API (jsdom default)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    expect(priv(surface).resolveCaretPoint(1, 1)).toBeNull();
  });

  it('maps a point via caretPositionFromPoint (spec / Firefox shape)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    stubCaret(tn, 3);
    expect(priv(surface).resolveCaretPoint(10, 10)).toEqual({ node: tn, offset: 3 });
  });

  it('maps a point via caretRangeFromPoint (WebKit / Chromium shape)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    (document as unknown as { caretRangeFromPoint: unknown }).caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(tn, 2);
      return r;
    };
    expect(priv(surface).resolveCaretPoint(10, 10)).toEqual({ node: tn, offset: 2 });
  });
});

describe('placeCaretAtPoint', () => {
  it('rejects a node outside the surface', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.textContent = 'x';
    expect(priv(surface).placeCaretAtPoint({ node: outside.firstChild!, offset: 0 })).toBe(false);
    outside.remove();
  });
});

describe('external drop', () => {
  it('lands plain text at the drop point through the paste pipeline', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    stubCaret(tn, 5); // end of "hello"
    const e = dropEvent(10, 10, transfer({ 'text/plain': 'X' }));
    priv(surface).onDrop(e);
    expect(e.defaulted).toBe(true); // native drop always cancelled
    expect(paraText(surface)).toBe('helloX');
  });

  it('interprets dropped HTML as Markdown', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('x\n') });
    const tn = container.querySelector('p')!.firstChild!;
    stubCaret(tn, 1);
    priv(surface).onDrop(dropEvent(10, 10, transfer({ 'text/html': '<em>hi</em>', 'text/plain': 'hi' })));
    const p = blocksOf(surface).find((b) => b.type === 'paragraph');
    if (!p || p.type !== 'paragraph') throw new Error('no paragraph');
    expect(inlinePlainText(p.inline)).toBe('xhi');
    expect(p.inline.some((n) => n.kind === 'text' && n.marks.em && n.text === 'hi')).toBe(true);
  });

  it('drops plain text verbatim into a code block', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\ncode\n```\n') });
    const codeTn = container.querySelector('code')!.firstChild!;
    stubCaret(codeTn, 4); // end of "code"
    priv(surface).onDrop(dropEvent(10, 10, transfer({ 'text/plain': 'X\nY' })));
    const c = blocksOf(surface).find((b) => b.type === 'code_block');
    if (!c || c.type !== 'code_block') throw new Error('no code block');
    expect(c.text).toBe('codeX\nY');
  });

  it('does nothing when the drop point resolves off the document', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    // no caret stub -> resolver returns null
    const e = dropEvent(9999, 9999, transfer({ 'text/plain': 'X' }));
    priv(surface).onDrop(e);
    expect(e.defaulted).toBe(true);
    expect(paraText(surface)).toBe('hello');
  });
});

describe('internal drag is refused honestly (rung 3)', () => {
  it('dragover over an internal drag sets dropEffect none and does not accept the drop', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    priv(surface).onDragStart();
    const dt = { dropEffect: '' } as unknown as DataTransfer;
    const e = { dataTransfer: dt, defaulted: false, preventDefault() { (e as { defaulted: boolean }).defaulted = true; } };
    priv(surface).onDragOver(e as unknown as Event);
    expect(dt.dropEffect).toBe('none');
    expect(e.defaulted).toBe(false); // not accepted: the browser won't fire `drop`
  });

  it('a drop while an internal drag is active is a clean no-op', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    stubCaret(tn, 5);
    priv(surface).onDragStart();
    const e = dropEvent(10, 10, transfer({ 'text/plain': 'X' }));
    priv(surface).onDrop(e);
    expect(e.defaulted).toBe(true); // native mutation still cancelled
    expect(paraText(surface)).toBe('hello'); // but nothing inserted
  });

  it('dragend clears the internal-drag flag so a later external drop is accepted', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    priv(surface).onDragStart();
    priv(surface).onDragEnd();
    const dt = { dropEffect: '' } as unknown as DataTransfer;
    const e = { dataTransfer: dt, defaulted: false, preventDefault() { (e as { defaulted: boolean }).defaulted = true; } };
    priv(surface).onDragOver(e as unknown as Event);
    expect(dt.dropEffect).toBe('copy');
    expect(e.defaulted).toBe(true);
  });
});
