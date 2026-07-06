// @vitest-environment jsdom
//
// Enter in a code block must drop exactly one line — even against WKWebView's
// native line-insert blindspot (SKR-224). In the real shell, Enter inside a code
// block advanced two lines AND the saved file gained two newlines: keydown's
// applyEnter inserts the model `\n`, then WKWebView performs the native line
// insert in the DOM anyway (keydown/beforeinput preventDefault does not suppress
// it there), and the compositionend code-block readback laundered that native
// duplicate straight into the model. Chromium/jsdom cannot reproduce the native
// event sequence, but we can SIMULATE it: drive keydown, then reproduce the
// native DOM duplicate + the readback, and assert the model keeps a single `\n`.
//
// Two layers are under test:
//  - Belt: onBeforeInput consumes insertLineBreak/insertParagraph in ALL contexts
//    (including while composing), ahead of the early-returns, so a native line
//    break can never reach a model path.
//  - Suspenders: the compositionend readback rejects a DOM that has diverged from
//    the model ONLY by added newline(s) — a native line insert is not composed
//    input, so it must not survive into the model.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

// Drive onBeforeInput with a synthetic InputEvent (jsdom does not dispatch a real
// beforeinput for a simulated gesture), returning whether it preventDefaulted.
function beforeInput(surface: BlockSurface, inputType: string, data?: string): boolean {
  let prevented = false;
  (surface as unknown as { onBeforeInput: (e: Event) => void }).onBeforeInput({
    inputType,
    data: data ?? null,
    preventDefault() {
      prevented = true;
    }
  } as unknown as Event);
  return prevented;
}
function keydown(surface: BlockSurface, init: KeyboardEventInit): void {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
}
function compositionEnd(surface: BlockSurface): void {
  (surface as unknown as { onCompositionEnd: () => void }).onCompositionEnd();
}
function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}
function codeBlock(surface: BlockSurface): Extract<BlockNode, { type: 'code_block' }> {
  const c = surface.getDocument().blocks.find((b) => b.type === 'code_block');
  if (!c || c.type !== 'code_block') throw new Error('no code block');
  return c;
}

describe('belt — onBeforeInput consumes native line breaks in all contexts', () => {
  it('swallows insertLineBreak in a code block without touching the model', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\nab\n```\n') });
    const code = container.querySelector('code')!;
    caretIn(code.firstChild!, 2);
    keydown(surface, { key: 'Enter' }); // model gains the one intended newline
    expect(codeBlock(surface).text).toBe('ab\n');

    // WKWebView's native insertLineBreak reaching beforeinput is a duplicate.
    const prevented = beforeInput(surface, 'insertLineBreak');
    expect(prevented).toBe(true);
    expect(codeBlock(surface).text).toBe('ab\n'); // still one newline
  });

  it('swallows insertParagraph in a prose paragraph without splitting again', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    caretIn(container.querySelector('p')!.firstChild!, 5);
    keydown(surface, { key: 'Enter' }); // one split -> two paragraphs
    const afterEnter = surface.getDocument().blocks.length;
    expect(afterEnter).toBe(2);

    const prevented = beforeInput(surface, 'insertParagraph');
    expect(prevented).toBe(true);
    expect(surface.getDocument().blocks.length).toBe(2); // no second split
  });

  it('consumes a line break even while composing (ahead of the composing return)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\nab\n```\n') });
    (surface as unknown as { composing: boolean }).composing = true;
    // Real IME never needs a native line break, so consuming it while composing is
    // safe — and it is what closes the phantom-composition bypass for code Enter.
    expect(beforeInput(surface, 'insertLineBreak')).toBe(true);
    expect(beforeInput(surface, 'insertParagraph')).toBe(true);
  });
});

describe('suspenders — compositionend readback rejects a native line-insert', () => {
  it('does not launder a duplicated newline into the code model', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\nab\n```\n') });
    const code = container.querySelector('code')!;
    caretIn(code.firstChild!, 2);
    keydown(surface, { key: 'Enter' });
    expect(codeBlock(surface).text).toBe('ab\n'); // model: one newline

    // Simulate WKWebView's native line insert: the DOM now carries the duplicate
    // newline the model never asked for, caret parked after it.
    code.textContent = 'ab\n\n';
    caretIn(code.firstChild!, 4);
    // The phantom composition around the code-block Enter fires compositionend,
    // which is where the readback ran.
    compositionEnd(surface);

    expect(codeBlock(surface).text).toBe('ab\n'); // model still one newline
    expect(container.querySelector('code')!.textContent).toBe('ab\n'); // DOM repaired
  });

  it('rejects the duplicate for a mid-text Enter and pulls the caret back one line', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\nabcd\n```\n') });
    const code = container.querySelector('code')!;
    caretIn(code.firstChild!, 2); // ab|cd
    keydown(surface, { key: 'Enter' });
    expect(codeBlock(surface).text).toBe('ab\ncd');

    code.textContent = 'ab\n\ncd'; // native duplicate at the caret
    caretIn(code.firstChild!, 4); // parked after the phantom newline
    compositionEnd(surface);

    expect(codeBlock(surface).text).toBe('ab\ncd');
    expect(container.querySelector('code')!.textContent).toBe('ab\ncd');
  });
});

describe('IME composition in a code block still reads back (unchanged)', () => {
  it('adopts genuinely composed characters (not a pure-newline diff)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\nab\n```\n') });
    const code = container.querySelector('code')!;
    code.textContent = 'ab日本語'; // IME committed characters into the DOM
    caretIn(code.firstChild!, code.firstChild!.textContent!.length);
    compositionEnd(surface);
    expect(codeBlock(surface).text).toBe('ab日本語');
    expect(codeBlock(surface).dirty).toBe(true);
  });
});
