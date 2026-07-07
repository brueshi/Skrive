// @vitest-environment jsdom
//
// The empty-block placeholder <br> under native-adjacent edits (SKR-192, the
// audit's F60/F61 pair re-specced against the placeholder model). Two exposures:
// the surgical delete path used to empty a text node IN PLACE with no re-render,
// leaving a block with no placeholder (zero-height caret in WKWebView until the
// next full render); and IME composition into an empty block can land text in
// FRONT of the placeholder, which the readback then misread as a trailing hard
// break (the lone-br guard only covered the only-child case).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { readInlineFromDOM } from '../../src/lib/blocksurface/inline-ops';
import { HARD_BREAK_ATTR } from '../../src/lib/blocksurface/render';
import { parseDocument } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

describe('surgical delete and the placeholder', () => {
  it('backspacing the last character re-renders the block with a placeholder <br>', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('a\n') });
    const p = container.querySelector('p')!;
    window.getSelection()!.collapse(p.firstChild!, 1);

    (surface as unknown as { applyDeleteBackward: () => void }).applyDeleteBackward();

    const block = surface.getDocument().blocks[0]!;
    expect(block.type === 'paragraph' ? block.inline : null).toEqual([]);
    // The emptied block keeps height and an addressable caret position.
    expect(p.querySelector('br')).not.toBeNull();
    expect(p.textContent).toBe('');
  });

  it('backspacing mid-text still takes the surgical path (no re-render)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    const p = container.querySelector('p')!;
    const tn = p.firstChild!;
    window.getSelection()!.collapse(tn, 2);

    (surface as unknown as { applyDeleteBackward: () => void }).applyDeleteBackward();

    // Same text node instance mutated in place — the hot path stayed surgical.
    expect(p.firstChild).toBe(tn);
    expect(tn.textContent).toBe('ac');
  });
});

describe('readInlineFromDOM and the placeholder', () => {
  it('drops a trailing untagged <br> (IME composed in front of the placeholder)', () => {
    const p = document.createElement('p');
    p.append(document.createTextNode('あ'), document.createElement('br'));

    expect(readInlineFromDOM(p)).toEqual([{ kind: 'text', text: 'あ', marks: {} }]);
  });

  it('keeps a trailing REAL hard break (tagged)', () => {
    const p = document.createElement('p');
    const br = document.createElement('br');
    br.setAttribute(HARD_BREAK_ATTR, '');
    p.append(document.createTextNode('a'), br);

    expect(readInlineFromDOM(p)).toEqual([
      { kind: 'text', text: 'a', marks: {} },
      { kind: 'break', marks: {} }
    ]);
  });

  it('still reads a lone placeholder as an empty block', () => {
    const p = document.createElement('p');
    p.append(document.createElement('br'));

    expect(readInlineFromDOM(p)).toEqual([]);
  });

  it('the compositionend readback carries no phantom break into the model', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('') });
    const p = container.querySelector('p')!;
    // Simulate the IME shape: composed text in front of the placeholder <br>.
    p.insertBefore(document.createTextNode('あ'), p.firstChild);
    window.getSelection()!.collapse(p.firstChild!, 1);

    (surface as unknown as { onCompositionEnd: () => void }).onCompositionEnd();

    const block = surface.getDocument().blocks[0]!;
    expect(block.type === 'paragraph' ? block.inline : null).toEqual([{ kind: 'text', text: 'あ', marks: {} }]);
  });
});
