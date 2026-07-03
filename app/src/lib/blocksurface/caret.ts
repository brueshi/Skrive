// Custom-drawn caret (SKR-202). The native contenteditable caret is painted at
// the full line-box height (font-size x line-height), so at the editor's
// default line-height it reads ~50% taller than the glyphs it sits between; no
// CSS shrinks only the native caret. The surface hides it (caret-color:
// transparent via .custom-caret) and paints its own: a glyph-height bar
// positioned from the live selection rect, vertically centered in the line box,
// so its height tracks the font — not the line-height setting.
//
// The caret element lives in the scroller, NOT inside the contenteditable — the
// reconciler and the selection mapping must never encounter it — and is
// positioned in the scroller's content coordinate space, so scrolling moves it
// for free with no scroll listener. Repositioning is selectionchange-driven and
// rAF-coalesced, the same discipline as the surface's selection observer.
//
// IME: while composing, the custom caret hides and the native caret returns
// (.is-composing restores caret-color) — WebKit draws its own composition
// caret/underline and fighting its geometry breaks marked-text editing.

const GLYPH_HEIGHT_FACTOR = 1.15;

export type CaretBox = { top: number; height: number };

/** The caret's vertical box within a line: glyph height (ascender + descender,
 *  ~1.15em for the editor's faces), centered in the line box and never taller
 *  than it (a heading at line-height 1.25 must not overflow its line). */
export function caretBox(lineTop: number, lineHeight: number, fontSize: number): CaretBox {
  const glyph = Math.round(fontSize * GLYPH_HEIGHT_FACTOR);
  const height = Math.min(glyph, Math.round(lineHeight));
  return { top: lineTop + (lineHeight - height) / 2, height };
}

type LineRect = { left: number; top: number; height: number };

/** The line rect of a collapsed selection, or null when the engine reports a
 *  degenerate rect (a caret on an empty block's placeholder <br>). */
function rangeLineRect(range: Range): LineRect | null {
  const rects = range.getClientRects();
  const r = rects.length > 0 ? rects[0]! : range.getBoundingClientRect();
  if (r.height === 0 && r.width === 0 && r.top === 0 && r.left === 0) return null;
  if (r.height === 0) return null;
  return { left: r.left, top: r.top, height: r.height };
}

/** Fallback line rect for an empty block: the element's content origin with its
 *  computed line-height. Same anchoring the slash menu uses for the degenerate
 *  empty-block rect (surface.refreshSlash). */
function emptyLineRect(el: HTMLElement): LineRect | null {
  const r = el.getBoundingClientRect();
  if (r.height === 0) return null;
  const cs = getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize) || 16;
  const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.2;
  return {
    left: r.left + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0),
    top: r.top + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0),
    height: lineHeight
  };
}

/** The element whose font sizes the caret: the text node's parent (so inline
 *  code's 0.88em caret is proportionally smaller, like its glyphs), else the
 *  container element itself. */
function elementAt(range: Range): HTMLElement | null {
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) return node.parentElement;
  return node instanceof HTMLElement ? node : null;
}

export type CustomCaretOptions = {
  /** The contenteditable host (.block-editor-surface). */
  surface: HTMLElement;
  /** The scrolling container (.block-editor-body); positions the caret element. */
  scroller: HTMLElement;
  /** The caret element itself (.skrive-caret), owned by the React tree. */
  caret: HTMLElement;
};

export type CustomCaretHandle = { destroy(): void };

/** Wire the custom caret to a surface. Returns a handle whose destroy() removes
 *  every listener and restores the native caret. Escape hatch: set
 *  localStorage['skrive:caret'] = 'native' to keep the native caret entirely
 *  (flag-revert per SKR-202) — the module then no-ops. */
export function attachCustomCaret({ surface, scroller, caret }: CustomCaretOptions): CustomCaretHandle {
  let native = false;
  try {
    native = localStorage.getItem('skrive:caret') === 'native';
  } catch {
    // No storage (tests): default to the custom caret.
  }
  if (native) return { destroy() {} };

  surface.classList.add('custom-caret');

  let scheduled = false;
  let composing = false;

  const hide = (): void => caret.classList.remove('is-visible');

  const update = (): void => {
    // Only a focused, collapsed caret inside the surface is drawn. A ranged
    // selection shows the native highlight; an unfocused surface shows nothing,
    // matching the native caret's behavior.
    if (composing || document.activeElement !== surface) return hide();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return hide();
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.startContainer)) return hide();
    const el = elementAt(range);
    if (!el) return hide();

    const line = rangeLineRect(range) ?? emptyLineRect(el);
    if (!line) return hide();
    const fontSize = parseFloat(getComputedStyle(el).fontSize) || 16;
    const box = caretBox(line.top, line.height, fontSize);

    // Viewport -> scroller-content coordinates: the caret then rides the scroll.
    const host = scroller.getBoundingClientRect();
    const x = line.left - host.left + scroller.scrollLeft;
    const y = box.top - host.top + scroller.scrollTop;
    caret.style.transform = `translate(${x}px, ${y}px)`;
    caret.style.height = `${box.height}px`;
    caret.classList.add('is-visible');
    // Restart the blink so the caret is solid while it travels (typing, arrows),
    // like the native caret. Web Animations rewind — no style/layout thrash.
    for (const a of caret.getAnimations()) a.currentTime = 0;
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  };

  const onCompositionStart = (): void => {
    composing = true;
    surface.classList.add('is-composing');
    hide();
  };
  const onCompositionEnd = (): void => {
    composing = false;
    surface.classList.remove('is-composing');
    schedule();
  };

  document.addEventListener('selectionchange', schedule);
  surface.addEventListener('focus', schedule);
  surface.addEventListener('blur', schedule);
  surface.addEventListener('compositionstart', onCompositionStart);
  surface.addEventListener('compositionend', onCompositionEnd);
  window.addEventListener('resize', schedule);
  // Reflows that move the caret without a selection change: measure/panel-width
  // changes, font-size preference edits. Both resize the surface.
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  resize?.observe(surface);

  schedule();

  return {
    destroy(): void {
      document.removeEventListener('selectionchange', schedule);
      surface.removeEventListener('focus', schedule);
      surface.removeEventListener('blur', schedule);
      surface.removeEventListener('compositionstart', onCompositionStart);
      surface.removeEventListener('compositionend', onCompositionEnd);
      window.removeEventListener('resize', schedule);
      resize?.disconnect();
      surface.classList.remove('custom-caret', 'is-composing');
      hide();
    }
  };
}
