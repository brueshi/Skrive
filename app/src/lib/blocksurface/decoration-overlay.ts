// The DOM half of the decoration layer — the painter for a DecorationStore. It
// mirrors the custom caret (caret.ts): the boxes live in a layer element inside
// the scroller, NOT inside the contenteditable, so they can never corrupt the
// editable text or the caret, and they ride scroll for free (positioned in the
// scroller's content coordinate space, the same viewport->content conversion the
// caret uses — no scroll listener). Repainting is rAF-coalesced and, on the
// keystroke path, touches only the one block that re-rendered.
//
// Geometry comes from the selection map: a decoration's `[start, end)` flat range
// resolves to two DOM points (domPointFromFlatOffset), a DOM Range spans them, and
// range.getClientRects() yields one rect per line box — so a decoration crossing a
// soft wrap paints as several boxes. Nothing here mutates the model or the text.

import { domPointFromFlatOffset } from './selection';
import { BLOCK_ID_ATTR } from './render';
import type { Decoration, DecorationStore } from './decorations';

export type DecorationOverlayOptions = {
  /** The contenteditable host (.block-editor-surface) whose block elements are
   *  measured for geometry. */
  surface: HTMLElement;
  /** The scrolling container (.block-editor-body); boxes are positioned in its
   *  content coordinate space, so they ride the scroll with no listener. */
  scroller: HTMLElement;
  /** The layer element (.block-decoration-layer) the boxes are appended to — a
   *  pointer-events:none sibling of the surface, owned by the React tree. */
  layer: HTMLElement;
  /** The decoration data, owned by the surface. */
  store: DecorationStore;
};

export type DecorationOverlayHandle = { destroy(): void };

const BOX_CLASS = 'sk-decoration';

/** A positioned box in the scroller's content coordinate space. */
export type ContentBox = { x: number; y: number; width: number; height: number };

/** Convert a viewport-space rect to the scroller's content coordinate space — the
 *  same conversion the custom caret uses, so decorations and caret share one
 *  coordinate system and both ride the scroll for free. Pure, so the mapping is
 *  unit-tested without layout (jsdom does not implement getClientRects). */
export function contentBox(
  rect: { left: number; top: number; width: number; height: number },
  hostRect: { left: number; top: number },
  scrollLeft: number,
  scrollTop: number
): ContentBox {
  return {
    x: rect.left - hostRect.left + scrollLeft,
    y: rect.top - hostRect.top + scrollTop,
    width: rect.width,
    height: rect.height
  };
}

/** The client rects a decoration covers, in viewport coordinates: one per line box
 *  (a wrapped range yields several). Empty for a degenerate or unresolvable range. */
function decorationRects(blockEl: HTMLElement, dec: Decoration): DOMRect[] {
  if (dec.end <= dec.start) return [];
  const a = domPointFromFlatOffset(blockEl, dec.start);
  const b = domPointFromFlatOffset(blockEl, dec.end);
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return [];
  }
  return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
}

/** Wire a decoration overlay to a surface. Returns a handle whose destroy() removes
 *  every listener and box. Mirrors attachCustomCaret's lifecycle. */
export function attachDecorationOverlay({
  surface,
  scroller,
  layer,
  store
}: DecorationOverlayOptions): DecorationOverlayHandle {
  // The painted boxes per block, so one block can be recomputed (old boxes
  // discarded, fresh ones measured) without walking the rest of the layer — the
  // keystroke path only ever repaints the block that just re-rendered.
  const boxesByBlock = new Map<string, HTMLElement[]>();

  // Coalesced work for the next frame. 'all' (a reflow / structural reconcile)
  // wins over a set of specific block ids.
  let dirty: Set<string> | 'all' = new Set();
  let scheduled = false;
  let rafId = 0;
  let destroyed = false;

  const dropBoxes = (blockId: string): void => {
    const boxes = boxesByBlock.get(blockId);
    if (!boxes) return;
    for (const box of boxes) box.remove();
    boxesByBlock.delete(blockId);
  };

  // Repaint one block: discard its old boxes, then, if its element is present and
  // it carries decorations, measure and place fresh boxes. An absent element
  // (virtualized out / not yet rendered) simply paints nothing — the block repaints
  // when it re-renders and the store invalidates it. `hostRect` is the scroller's
  // viewport rect, read once per frame and shared across blocks.
  const paintBlock = (blockId: string, hostRect: DOMRect): void => {
    dropBoxes(blockId);
    const decs = store.forBlock(blockId);
    if (decs.length === 0) return;
    const blockEl = surface.querySelector<HTMLElement>(`[${BLOCK_ID_ATTR}="${blockId}"]`);
    if (!blockEl) return;

    const created: HTMLElement[] = [];
    for (const dec of decs) {
      for (const rect of decorationRects(blockEl, dec)) {
        const box = document.createElement('div');
        box.className = `${BOX_CLASS} ${BOX_CLASS}--${dec.type}`;
        // Viewport -> scroller-content coordinates: the box then rides the scroll,
        // exactly as the custom caret does.
        const { x, y, width, height } = contentBox(rect, hostRect, scroller.scrollLeft, scroller.scrollTop);
        box.style.transform = `translate(${x}px, ${y}px)`;
        box.style.width = `${width}px`;
        box.style.height = `${height}px`;
        layer.appendChild(box);
        created.push(box);
      }
    }
    if (created.length > 0) boxesByBlock.set(blockId, created);
  };

  const flush = (): void => {
    scheduled = false;
    if (destroyed) return;
    const work = dirty;
    dirty = new Set();
    const hostRect = scroller.getBoundingClientRect();
    if (work === 'all') {
      // A full reassess: every block that has a box now (so a removed / undecorated
      // block gets cleaned) plus every decorated block (so one whose element just
      // reappeared paints). The union, since neither set is a superset.
      const ids = new Set<string>(boxesByBlock.keys());
      for (const id of store.blockIds()) ids.add(id);
      for (const id of ids) paintBlock(id, hostRect);
    } else {
      for (const id of work) paintBlock(id, hostRect);
    }
  };

  const schedule = (invalidated: readonly string[] | null): void => {
    if (invalidated === null) dirty = 'all';
    else if (dirty !== 'all') for (const id of invalidated) dirty.add(id);
    if (scheduled) return;
    scheduled = true;
    rafId = requestAnimationFrame(flush);
  };

  const onReflow = (): void => schedule(null);

  const unsubscribe = store.subscribe(schedule);
  window.addEventListener('resize', onReflow);
  // Reflows that move decorations without a store change: measure / panel-width
  // edits, font-size preference changes. Both resize the surface.
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onReflow) : null;
  resizeObserver?.observe(surface);

  // Paint anything already present (normally nothing at attach time).
  schedule(null);

  return {
    destroy(): void {
      destroyed = true;
      unsubscribe();
      window.removeEventListener('resize', onReflow);
      resizeObserver?.disconnect();
      if (scheduled) cancelAnimationFrame(rafId);
      for (const boxes of boxesByBlock.values()) for (const box of boxes) box.remove();
      boxesByBlock.clear();
      layer.textContent = '';
    }
  };
}
