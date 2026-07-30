// Per-block hover chrome — the grip and `+` that let a writer act on a block by
// pointing at it instead of by remembering a chord. The affordance grammar puts
// block-contextual actions here (per-block chrome), never on the toolbar.
//
// Architecture is table-chrome.ts's, one level up, and deliberately so: a block
// grip and a table row grip sit inches apart, so they share a layer model, a
// hover lifecycle, and a visual language rather than growing two of each. The
// layer lives in the scroller but OUTSIDE the contenteditable, so it can never
// corrupt the editable text or the caret, and its slots are placed in the
// scroller's content coordinate space, so they ride scroll with no listener. It
// is rebuilt from the surface's structural-change signal, never from the
// keystroke path.
//
// Geometry is MEASURED — a block's height is whatever its wrapped text needs, and
// the model holds no layout — but the arithmetic that turns a measured box into
// slot positions is pure and unit-tested without layout, since jsdom implements
// no box geometry.

import { contentBox, type ContentBox } from './decoration-overlay';
import { BLOCK_ID_ATTR } from './render';
import { nearestBoundary, zoneContains, type HoverZone } from './table-chrome';
import type { BlockSurface } from './surface';

/** Chrome sizing. The gutter is an overlay, so these reserve no layout space —
 *  they only decide how far into the margin the chrome floats. */
export const BLOCK_CHROME_METRICS = {
  /** Width of the grip bar. */
  gripWidth: 5,
  /** Height of the grip bar. Short, and centred on the block's FIRST line rather
   *  than on the block, so a twenty-line paragraph and a one-line one carry their
   *  grip at the same place relative to where the writer is reading. */
  gripHeight: 20,
  /** Edge length of the square `+` button. */
  plusSize: 18,
  /** Gap between the grip and the block's left edge. */
  gripGap: 10,
  /** Gap between the `+` and the grip. */
  plusGap: 4,
  /** The first line's height when a block's own height is smaller (an empty
   *  paragraph measures short); keeps the grip from collapsing on a blank line. */
  minLineHeight: 20
} as const;

export type BlockChromeMetrics = typeof BLOCK_CHROME_METRICS;

/** Grace margin, in px, added around the block and its gutter to form the hover
 *  zone. The chrome sits OUTSIDE the block, so reaching from the text to the grip
 *  crosses margin that belongs to no block; without a grace zone that crossing
 *  reads as leaving the block and dismisses the chrome the pointer is heading for. */
const ZONE_SLACK = 12;

/** How long, in ms, the chrome lingers after the pointer leaves the zone.
 *  Cancelled the instant the pointer returns, so a near-miss on the grip or a dip
 *  through the gutter never flickers the chrome away. */
const HIDE_DELAY_MS = 140;

const SLOT_CLASS = 'sk-block-chrome';

/** Pointer travel, in px, before a grip press becomes a reorder drag. Below it the
 *  press stays a click that selects the block. */
const REORDER_MOVE_THRESHOLD_PX = 4;

/** Body class held while a block is being dragged, for the grabbing cursor and to
 *  suppress text selection for the length of the drag. */
const REORDERING_CLASS = 'sk-block-reordering';

/** Marks the block being dragged, so it dims for the length of the gesture — the
 *  "what am I moving" half of the feedback, paired with the drop line's "where
 *  will it land". View-only; cleared on drop. */
const DRAG_BLOCK_ATTR = 'data-block-dragging';

/** The class render.ts gives a footnote definition's element. Definitions are
 *  display-gathered into a document-end footer, so they sit outside the reorder. */
const FOOTNOTE_DEF_CLASS = 'sk-footnote-def';

/** One painted affordance, positioned in the scroller's content coordinate space. */
export type BlockSlot = {
  kind: 'grip' | 'insert';
  x: number;
  y: number;
  width: number;
  height: number;
};

/** A hovered block's measured shape, plus the height of its first line — which is
 *  what the chrome aligns to, not the block's full height. */
export type BlockGeometry = { box: ContentBox; firstLineHeight: number };

/**
 * The two slots for a measured block: a grip in the left gutter and a `+` outboard
 * of it. Both are centred on the block's FIRST LINE, so they land beside the text
 * a writer is looking at rather than halfway down a long paragraph.
 *
 * Ordered `+` then grip from the outside in, which puts the grip — the affordance
 * that acts on THIS block — nearest the block it addresses, and the insert, which
 * acts on the seam above, further out.
 *
 * Pure: no DOM, no measurement. Everything it needs is in `geom`.
 */
export function blockChromeSlots(geom: BlockGeometry, m: BlockChromeMetrics = BLOCK_CHROME_METRICS): BlockSlot[] {
  const line = Math.max(geom.firstLineHeight, m.minLineHeight);
  // Centre both slots on the first line's midpoint.
  const mid = geom.box.y + line / 2;
  // The cluster normally floats in the margin outside the writing measure. In a
  // window narrower than the measure the surface fills the scroller and there is
  // no margin left to float in, so the whole cluster shifts right just enough to
  // stay on canvas — it then overlaps the text's padding, which is a visible
  // affordance in a cramped window rather than an invisible one off the edge.
  const wanted = geom.box.x - m.gripGap - m.gripWidth - m.plusGap - m.plusSize;
  const plusX = Math.max(0, wanted);
  const gripX = plusX + m.plusSize + m.plusGap;
  return [
    {
      kind: 'insert',
      x: plusX,
      y: mid - m.plusSize / 2,
      width: m.plusSize,
      height: m.plusSize
    },
    {
      kind: 'grip',
      x: gripX,
      y: mid - m.gripHeight / 2,
      width: m.gripWidth,
      height: m.gripHeight
    }
  ];
}

/** The hover zone around a block: its own box grown left to swallow the gutter the
 *  chrome floats in, plus slack on every side. Viewport coordinates, matching the
 *  rect a pointer event reports. The zone shape and its hit test are the table
 *  chrome's — the same idea at a different scale, so they are shared rather than
 *  written twice; only the gutter reach differs. */
export function blockHoverZone(
  rect: { left: number; top: number; right: number; bottom: number },
  m: BlockChromeMetrics = BLOCK_CHROME_METRICS
): HoverZone {
  // The gutter's full reach: the `+` is the outermost element.
  const gutter = m.gripGap + m.gripWidth + m.plusGap + m.plusSize;
  return {
    left: rect.left - gutter - ZONE_SLACK,
    top: rect.top - ZONE_SLACK,
    right: rect.right + ZONE_SLACK,
    bottom: rect.bottom + ZONE_SLACK
  };
}

/**
 * The `n + 1` y positions a reorder can drop at, given the boxes of the draggable
 * blocks in document order: every block's top edge, then the last one's bottom.
 * The same shape as a table's rowEdges, so the same nearestBoundary hit test
 * applies — a drop boundary is an index INTO this list, which is exactly the
 * insertion boundary moveBlock takes.
 */
export function blockDropEdges(boxes: ContentBox[]): number[] {
  if (boxes.length === 0) return [];
  const edges = boxes.map((b) => b.y);
  const last = boxes[boxes.length - 1]!;
  edges.push(last.y + last.height);
  return edges;
}

/**
 * The drop indicator's rect for a boundary: a full-width rule spanning the widest
 * draggable block, centred on the boundary so it reads as a line BETWEEN blocks
 * rather than as a line belonging to either one.
 */
export function blockDropIndicatorRect(
  boxes: ContentBox[],
  to: number,
  thickness = 2
): { x: number; y: number; width: number; height: number } | null {
  const edges = blockDropEdges(boxes);
  const y = edges[to];
  if (y === undefined) return null;
  let x = Infinity;
  let right = -Infinity;
  for (const b of boxes) {
    if (b.x < x) x = b.x;
    if (b.x + b.width > right) right = b.x + b.width;
  }
  return { x, y: y - thickness / 2, width: right - x, height: thickness };
}

/** Measure a block element into the scroller's content coordinate space, reading
 *  the first line's height from the element's first client rect — a wrapped
 *  paragraph reports one rect per line, so the first is the line the chrome aligns
 *  to. Falls back to the block's own height for an element that reports no rects. */
export function measureBlock(
  el: HTMLElement,
  hostRect: { left: number; top: number },
  scrollLeft: number,
  scrollTop: number
): BlockGeometry | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const box = contentBox(rect, hostRect, scrollLeft, scrollTop);
  const first = el.getClientRects()[0];
  return { box, firstLineHeight: first ? first.height : rect.height };
}

export type BlockChromeOptions = {
  /** The contenteditable host (.block-editor-surface) holding the blocks. */
  surface: HTMLElement;
  /** The scrolling container (.block-editor-body); slots are positioned in its
   *  content coordinate space, so they ride the scroll with no listener. */
  scroller: HTMLElement;
  /** The layer element (.block-chrome-layer) the slots are appended to — a sibling
   *  of the surface, owned by the React tree. */
  layer: HTMLElement;
  /** The surface the affordances act on. */
  blockSurface: BlockSurface;
};

export type BlockChromeHandle = { destroy(): void };

const SLOT_LABELS: Record<BlockSlot['kind'], string> = {
  grip: 'Select block',
  insert: 'Insert a block above'
};

/** Wire per-block hover chrome to a surface. Returns a handle whose destroy()
 *  removes every listener and slot. Mirrors attachTableChrome's lifecycle. */
export function attachBlockChrome({
  surface,
  scroller,
  layer,
  blockSurface
}: BlockChromeOptions): BlockChromeHandle {
  // The top-level block element whose chrome is up, or null.
  let active: HTMLElement | null = null;
  // The surface's block selection, so a selected block's grip stays lit
  // independent of hover.
  let selected = new Set(blockSurface.getSelectedBlockIds());
  let scheduled = false;
  let rafId = 0;
  let hideTimer = 0;
  let destroyed = false;
  // A grip press that became a reorder drag must swallow the click the browser
  // fires on release, so a drop doesn't also select the block it just moved.
  let suppressClick = false;
  // The teardown for an in-flight reorder. Held at attach scope so a click (which
  // WKWebView fires even when it drops the pointerup on a motionless press) and
  // destroy() can both tidy a gesture's window listeners — no leak on a tap.
  let activeReorderCleanup: (() => void) | null = null;

  const clear = (): void => {
    layer.textContent = '';
  };

  /** The top-level blocks a reorder can address, in document order, with their
   *  measured boxes. Footnote definitions are EXCLUDED: they are gathered into a
   *  generated document-end footer for display, so their on-screen position is not
   *  a place in the document and dropping into that footer would move a block
   *  somewhere it would not appear. Everything else keeps its relative model order
   *  on screen, so a boundary index here IS a model insertion boundary. */
  const draggableBlocks = (): { id: string; el: HTMLElement; box: ContentBox }[] => {
    const hostRect = scroller.getBoundingClientRect();
    const out: { id: string; el: HTMLElement; box: ContentBox }[] = [];
    for (const child of Array.from(surface.children)) {
      const el = child as HTMLElement;
      const id = el.getAttribute(BLOCK_ID_ATTR);
      if (!id || el.classList.contains(FOOTNOTE_DEF_CLASS)) continue;
      const geom = measureBlock(el, hostRect, scroller.scrollLeft, scroller.scrollTop);
      if (geom) out.push({ id, el, box: geom.box });
    }
    return out;
  };

  /** Build one slot's button and append it. */
  const renderSlot = (blockId: string, slot: BlockSlot): void => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `${SLOT_CLASS} ${SLOT_CLASS}--${slot.kind}`;
    if (slot.kind === 'grip' && selected.has(blockId)) el.classList.add('is-selected');
    el.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
    el.style.width = `${slot.width}px`;
    el.style.height = `${slot.height}px`;
    el.setAttribute('aria-label', SLOT_LABELS[slot.kind]);
    // Bound to click, NOT pointerup: WKWebView drops pointerup on a motionless
    // press, and the Chromium latency gate is blind to that difference.
    el.addEventListener('click', (e) => {
      // A click that closes a motionless press tidies any reorder gesture whose
      // pointerup WKWebView may have dropped; then the press acts as a plain click.
      activeReorderCleanup?.();
      if (suppressClick) {
        // The click that follows a reorder drag: swallow it so the drop doesn't
        // also select the block it just moved.
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      if (slot.kind === 'grip') blockSurface.selectBlockAt(blockId);
      else blockSurface.insertBlockAbove(blockId);
    });
    // The grip is also a reorder handle: a press that crosses the move threshold
    // drags the block to a new position.
    if (slot.kind === 'grip') {
      el.addEventListener('pointerdown', (ev) => beginReorder(ev, blockId, el));
    }
    // Keep a press on the chrome from stealing the caret out of the block before
    // the op runs.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    layer.appendChild(el);
  };

  /** Drag a grip to a new position. The press stays a click (select the block)
   *  until it crosses the move threshold, at which point it becomes a reorder: a
   *  drop-indicator line tracks the nearest boundary and the move commits once on
   *  release as a single undo step. Listens on the scroller/window rather than
   *  capturing the tiny grip, so a drag that wanders off it still tracks; cleanup
   *  runs on pointerup, pointercancel, or — if WKWebView drops the pointerup on a
   *  motionless press — the ensuing click. */
  const beginReorder = (e: PointerEvent, blockId: string, el: HTMLElement): void => {
    if (e.button !== 0) return;
    activeReorderCleanup?.(); // tidy any prior gesture that leaked
    const blocks = draggableBlocks();
    const from = blocks.findIndex((b) => b.id === blockId);
    if (from < 0) return; // a footnote definition's grip: click-only
    const boxes = blocks.map((b) => b.box);
    const edges = blockDropEdges(boxes);
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    let dropTo = from;
    let indicator: HTMLElement | null = null;

    const cleanup = (): void => {
      scroller.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      activeReorderCleanup = null;
      if (moved) {
        document.body.classList.remove(REORDERING_CLASS);
        el.classList.remove('is-dragging');
        indicator?.remove();
        blocks[from]?.el.removeAttribute(DRAG_BLOCK_ATTR);
      }
    };
    const onMove = (ev: PointerEvent): void => {
      if (!moved) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < REORDER_MOVE_THRESHOLD_PX) return;
        moved = true;
        blockSurface.clearCaret();
        document.body.classList.add(REORDERING_CLASS);
        el.classList.add('is-dragging');
        blocks[from]?.el.setAttribute(DRAG_BLOCK_ATTR, '');
        indicator = document.createElement('div');
        indicator.className = `${SLOT_CLASS} ${SLOT_CLASS}--drop`;
        layer.appendChild(indicator);
      }
      const host = scroller.getBoundingClientRect();
      const pos = ev.clientY - host.top + scroller.scrollTop;
      dropTo = nearestBoundary(edges, pos);
      const r = blockDropIndicatorRect(boxes, dropTo);
      if (!r) return;
      indicator!.style.transform = `translate(${r.x}px, ${r.y}px)`;
      indicator!.style.width = `${r.width}px`;
      indicator!.style.height = `${r.height}px`;
    };
    const onUp = (): void => {
      const didMove = moved;
      const to = dropTo;
      cleanup();
      if (didMove) {
        suppressClick = true;
        // The boundary indexes the VISIBLE blocks, so hand the surface the block
        // the drop landed above (null at the very end) rather than the number —
        // the model's order is not the screen's wherever a footnote definition
        // has been gathered into the footer.
        blockSurface.moveBlockBefore(blockId, blocks[to]?.id ?? null);
      }
    };
    activeReorderCleanup = cleanup;
    scroller.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  /** The top-level block element for an id, or null. Top-level only: a nested
   *  block carries the same attribute, so this scopes to direct children. */
  const blockElementById = (id: string): HTMLElement | null => {
    for (const child of Array.from(surface.children)) {
      if ((child as HTMLElement).getAttribute(BLOCK_ID_ATTR) === id) return child as HTMLElement;
    }
    return null;
  };

  const renderBlock = (el: HTMLElement): void => {
    const blockId = el.getAttribute(BLOCK_ID_ATTR);
    if (!blockId) return;
    const geom = measureBlock(el, scroller.getBoundingClientRect(), scroller.scrollLeft, scroller.scrollTop);
    if (!geom) return;
    for (const slot of blockChromeSlots(geom)) renderSlot(blockId, slot);
  };

  const paint = (): void => {
    scheduled = false;
    if (destroyed) return;
    clear();
    if (active && !active.isConnected) active = null;
    if (active) renderBlock(active);
    // A selected block keeps its grip lit with the pointer away. Skipped when it
    // IS the hovered block, which already drew one.
    for (const id of selected) {
      const el = blockElementById(id);
      if (el && el !== active) renderBlock(el);
    }
  };

  const schedule = (): void => {
    if (scheduled || destroyed) return;
    scheduled = true;
    rafId = requestAnimationFrame(paint);
  };

  const cancelHide = (): void => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
  };

  const setActive = (el: HTMLElement | null): void => {
    if (el === active) return;
    active = el;
    schedule();
  };

  const scheduleHide = (): void => {
    if (hideTimer || !active) return;
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      setActive(null);
    }, HIDE_DELAY_MS);
  };

  /** The TOP-LEVEL block element containing a target, or null. The grip addresses
   *  top-level blocks only — a paragraph inside a list item resolves to the list. */
  const topLevelBlockOf = (target: HTMLElement): HTMLElement | null => {
    let node: HTMLElement | null = target;
    while (node && node.parentElement !== surface) node = node.parentElement;
    return node && node.hasAttribute(BLOCK_ID_ATTR) ? node : null;
  };

  // Hover tracking runs on the scroller, not the blocks, because the chrome sits
  // OUTSIDE the block element. Over a block: adopt it. Over a chrome element or
  // anywhere in the grace zone (the gutter, which hit-tests to no block): hold the
  // current state — crucially, do NOT clear it, or moving onto the grip to click
  // would erase the thing being clicked.
  const onPointerOver = (e: PointerEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const block = topLevelBlockOf(target);
    if (block) {
      cancelHide();
      setActive(block);
      return;
    }
    if (!active) return;
    if (layer.contains(target)) {
      cancelHide(); // over the active block's grip or `+`
      return;
    }
    if (zoneContains(blockHoverZone(active.getBoundingClientRect()), e.clientX, e.clientY)) {
      cancelHide(); // in the gutter: hold
      return;
    }
    scheduleHide();
  };

  const onPointerLeave = (): void => scheduleHide();

  const onReflow = (): void => {
    if (active || selected.size > 0) schedule();
  };

  // A structural pass rebuilds block elements wholesale (replaceWith), so every
  // measured rect is stale afterwards. The same signal the decoration overlay and
  // the table chrome ride, and provably off the keystroke path.
  const unsubscribe = blockSurface.onStructureChange(() => {
    // The element identity changed; re-resolve the active block by id.
    if (active) {
      const blockId = active.getAttribute(BLOCK_ID_ATTR);
      active = blockId ? blockElementById(blockId) : null;
    }
    if (active || selected.size > 0) schedule();
  });

  const unsubscribeSelection = blockSurface.onBlockSelectionChange(() => {
    selected = new Set(blockSurface.getSelectedBlockIds());
    schedule();
  });

  // No scroll listener: the layer lives inside the scroller and its slots are
  // placed in content coordinates, so they ride the scroll for free — the same
  // reason the caret and the decoration overlay need none.
  scroller.addEventListener('pointerover', onPointerOver);
  scroller.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('resize', onReflow);
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onReflow) : null;
  resizeObserver?.observe(surface);

  return {
    destroy(): void {
      destroyed = true;
      unsubscribe();
      unsubscribeSelection();
      scroller.removeEventListener('pointerover', onPointerOver);
      scroller.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('resize', onReflow);
      resizeObserver?.disconnect();
      if (scheduled) cancelAnimationFrame(rafId);
      cancelHide();
      active = null;
      clear();
    }
  };
}
