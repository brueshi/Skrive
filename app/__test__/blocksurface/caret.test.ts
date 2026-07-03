// @vitest-environment jsdom
//
// Custom caret geometry + lifecycle (SKR-202). The box math is the caret's whole
// contract — glyph-height, centered in the line box, clamped to it — so it is
// pinned directly. The attach/destroy lifecycle is exercised in jsdom: class
// toggling on the surface (which is what hides/restores the native caret) and
// IME composition switching back to the native caret.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { caretBox, attachCustomCaret, type CustomCaretHandle } from '../../src/lib/blocksurface/caret';

describe('caretBox', () => {
  it('is glyph-height (1.15em), centered in the line box', () => {
    // 17px font at line-height 1.7 => 28.9px line box, ~20px caret.
    const box = caretBox(100, 28.9, 17);
    expect(box.height).toBe(20); // round(17 * 1.15)
    expect(box.top).toBeCloseTo(100 + (28.9 - 20) / 2);
  });

  it('never exceeds the line box (tight heading line-height)', () => {
    // 28px h1 at line-height 1.25 => 35px line box; glyph would be 32, fits.
    expect(caretBox(0, 35, 28).height).toBe(32);
    // Degenerate: line box smaller than the glyph clamps to the line box.
    const clamped = caretBox(0, 18, 17);
    expect(clamped.height).toBe(18);
    expect(clamped.top).toBe(0);
  });

  it('scales with the font, not the line-height', () => {
    // Same font, wildly different line-heights: caret height is identical.
    expect(caretBox(0, 25.5, 17).height).toBe(caretBox(0, 34, 17).height);
  });
});

describe('attachCustomCaret', () => {
  let surface: HTMLElement;
  let scroller: HTMLElement;
  let caretEl: HTMLElement;
  let handle: CustomCaretHandle | null = null;

  beforeEach(() => {
    scroller = document.createElement('div');
    surface = document.createElement('div');
    caretEl = document.createElement('div');
    scroller.append(surface, caretEl);
    document.body.appendChild(scroller);
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    scroller.remove();
  });

  it('hides the native caret on attach and restores it on destroy', () => {
    handle = attachCustomCaret({ surface, scroller, caret: caretEl });
    expect(surface.classList.contains('custom-caret')).toBe(true);
    handle.destroy();
    handle = null;
    expect(surface.classList.contains('custom-caret')).toBe(false);
    expect(surface.classList.contains('is-composing')).toBe(false);
  });

  it('returns the native caret during IME composition', () => {
    handle = attachCustomCaret({ surface, scroller, caret: caretEl });
    surface.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(surface.classList.contains('is-composing')).toBe(true);
    expect(caretEl.classList.contains('is-visible')).toBe(false);
    surface.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(surface.classList.contains('is-composing')).toBe(false);
  });

  it('no-ops entirely when the native-caret escape hatch is set', () => {
    localStorage.setItem('skrive:caret', 'native');
    try {
      handle = attachCustomCaret({ surface, scroller, caret: caretEl });
      expect(surface.classList.contains('custom-caret')).toBe(false);
    } finally {
      localStorage.removeItem('skrive:caret');
    }
  });
});
