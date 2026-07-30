// The outline rail: a slim column of ticks down the right edge of the
// document pane — the rendered Markdown preview or the rich block surface
// (SKR-229) — one per heading. The tick for the section you're currently
// reading is emphasized; clicking a tick scrolls there, and dragging the
// rail scrubs the document. On hover or keyboard focus it expands into a
// labeled popover (Image #2) listing every heading, held roughly central
// and nudged slightly toward the selected tick.
//
// Why it reads the DOM rather than re-parsing the body: the headings are
// already in the rendered output carrying the exact `id`s anchor links
// use, and only the DOM knows their real pixel offsets after wrapping,
// images, and variable block heights. So this component measures the
// rendered headings and delegates the one piece with genuine edge cases
// — which heading is "active" — to the pure `activeHeadingIndex`.
//
// Focus model: the rail is the single tab stop and owns all keyboard
// handling (a listbox with `aria-activedescendant`). Ticks and popover
// rows suppress focus on mousedown so a click never moves focus into the
// subtree, which keeps the open/selection state unambiguous.

import { AnimatePresence } from 'framer-motion';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { activeHeadingIndex, type OutlineHeading } from '../../lib/preview/outline';
import { BLOCK_ID_ATTR } from '../../lib/blocksurface/render';
import { OutlinePopover } from './OutlinePopover';

type Props = {
  /** The scroll container (`.preview`, or `.block-editor-body` in rich mode). */
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  /** The content holding the rendered headings (`.preview-inner`, or
   *  `.block-editor-surface` in rich mode). */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Changes when the heading *structure* of the content changes — count,
   * levels, or texts (see `headingStructureKey` in Preview.tsx) — and
   * triggers a full re-measure. Paragraph-only edits keep it stable;
   * offset shifts from reflow (images decoding, pane resize) reach us
   * through the ResizeObserver path instead.
   *
   * Only meaningful for content that is replaced wholesale (the preview's
   * innerHTML swap). A surface that reconciles its DOM in place has no
   * honest key to offer and passes `subscribeStructure` instead.
   */
  renderKey: string;
  /**
   * Structural-change subscription for surfaces reconciled in place. The
   * block surface calls back on exactly the passes that add, remove, or
   * replace block elements — the edits that can change the outline —
   * which is the signal `renderKey` cannot carry there.
   *
   * Without it the only structural trigger is the ResizeObserver, which
   * infers "the headings changed" from "the content got taller". Edits
   * that keep the height identical (renaming a heading that doesn't
   * rewrap, reordering two equal-height blocks) never fire it and leave
   * the strip stale. Returns an unsubscribe.
   */
  subscribeStructure?: (fn: () => void) => () => void;
};

// Headings need at least this many to be worth a rail; one heading is
// just the document title and adds only clutter.
const MIN_HEADINGS = 2;
// Clicked headings land this far below the top edge rather than flush.
const SCROLL_MARGIN = 16;
// The active-section line must sit *below* where a clicked heading
// lands, or a sub-pixel scroll undershoot (heading offsets are
// fractional, scrollTop rounds to an integer) flips the selection to the
// heading above. Keeping the offset comfortably greater than
// SCROLL_MARGIN gives that slack.
const ACTIVATION_OFFSET = 40;
// The ticks form one compact, vertically-centered cluster rather than
// stretching the full height of the pane. Preferred gap between ticks;
// capped down to fit when a document has many headings.
const IDEAL_GAP = 14;
const VERTICAL_PAD = 20;
// Grace period bridging the gap between the rail strip and the popover
// so a quick mouse move between them doesn't dismiss it.
const CLOSE_GRACE_MS = 140;
// Keep the popover this far from the top/bottom edges of the pane.
const POPOVER_PAD = 12;
// How far the popover drifts from dead-center toward the selected tick.
// Small on purpose: it holds a roughly central position and only varies
// slightly so it reads as connected to the tick without chasing it.
const POPOVER_DAMP = 0.25;
// Pointer travel past which a press becomes a scrub rather than a tap.
const DRAG_THRESHOLD = 4;
// Trailing settle window for resize-driven re-measures. A burst of
// content reflows (twenty images decoding as a document opens) collapses
// to one leading measure plus one at this long after the burst quiets,
// instead of a measure per reflow.
const RESIZE_SETTLE_MS = 150;

const optionId = (index: number) => `skrive-outline-option-${index}`;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);

function queryHeadingEls(content: HTMLElement): HTMLElement[] {
  return Array.from(
    content.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
  );
}

/**
 * Stable identity for a heading element, for keying fold state and React
 * rows. The rich surface tags every block with a block id that survives
 * edits and reordering; the rendered preview has no such attribute but
 * assigns anchor slugs. The index is a last resort — it keeps folding
 * working on a surface offering neither, at the cost of a fold sliding
 * onto its neighbour when headings move.
 *
 * The prefixes keep the three namespaces apart, so a slug that happens to
 * read like a block id can never collide with one.
 */
function headingKey(el: HTMLElement, index: number): string {
  const blockId = el.getAttribute(BLOCK_ID_ATTR);
  if (blockId) return `b:${blockId}`;
  if (el.id) return `s:${el.id}`;
  return `i:${index}`;
}

export function OutlineRail({
  scrollerRef,
  contentRef,
  renderKey,
  subscribeStructure
}: Props) {
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  // The rail spans the scroller, so its height is the scroller's visible
  // height — used to center the tick cluster.
  const [railHeight, setRailHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  // Popover open state is the union of hover and focus, minus an
  // explicit Escape dismissal that lasts only until the pointer/focus
  // leaves entirely.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Keyboard cursor. Until the reader presses an arrow, the highlight
  // simply follows the active section as they scroll.
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  // Measured popover height, so the card stays centered-ish and clamped
  // within the pane regardless of how many headings it lists.
  const [popoverHeight, setPopoverHeight] = useState(0);
  // True while a press has turned into a scrub-drag.
  const [scrubbing, setScrubbing] = useState(false);

  const popoverRef = useRef<HTMLDivElement | null>(null);
  // Heading elements from the last structural measure. The resize path
  // refreshes offsets against this cache instead of rebuilding the
  // heading list, and an identity check against a fresh query detects
  // when the element list itself changed underneath us — Rich-surface
  // edits (whose renderKey is a constant), or a preview innerHTML swap
  // replacing the nodes (rect-reading detached nodes would yield zeros).
  const headingElsRef = useRef<HTMLElement[]>([]);
  // The current measure closure, exposed outside the effect so
  // interaction handlers (pointer entering the rail, keyboard focus) can
  // refresh just-in-time before a click or popover needs fresh anchors.
  const measureRef = useRef<(() => void) | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The in-flight press: where it started, which tick it landed on (if
  // any), and whether it has crossed the drag threshold yet.
  const pressRef = useRef<{
    startY: number;
    tickIndex: number | null;
    moved: boolean;
  } | null>(null);

  // Re-measure on first paint, whenever the heading structure changes
  // (renderKey), and — coalesced — whenever content reflows (images
  // decoding, window resize), all of which move heading offsets.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;

    const measure = () => {
      const els = queryHeadingEls(content);
      const scRect = scroller.getBoundingClientRect();
      // Offset within the scroller content, independent of which
      // ancestor happens to be the offsetParent.
      const measured = els.map((el) => ({
        el,
        top: el.getBoundingClientRect().top - scRect.top + scroller.scrollTop
      }));
      const tops = measured.map((m) => m.top);
      const cached = headingElsRef.current;
      const sameStructure =
        els.length === cached.length && els.every((el, i) => el === cached[i]);
      if (sameStructure) {
        // Same elements, so no headings came or went: patch the fields
        // that can drift on a kept element — offset (reflow) and text/id
        // (a Rich-surface rename edits the node in place; both are plain
        // property reads, no layout) — while keeping object identity, and
        // skip the state write entirely (no render, no downstream effect
        // churn) when nothing actually changed. Depth can't drift: a
        // level change replaces the element, failing the identity check.
        setHeadings((prev) => {
          let changed = false;
          const next = prev.map((h, i) => {
            const el = els[i];
            const top = tops[i];
            if (el === undefined || top === undefined) return h;
            const text = el.textContent ?? '';
            const key = headingKey(el, i);
            if (top === h.top && text === h.text && key === h.key) return h;
            changed = true;
            return { ...h, top, text, key };
          });
          return changed ? next : prev;
        });
      } else {
        headingElsRef.current = els;
        setHeadings(
          measured.map(({ el, top }, i) => ({
            key: headingKey(el, i),
            text: el.textContent ?? '',
            depth: Number(el.tagName[1]) || 1,
            top
          }))
        );
      }
      setRailHeight(scroller.clientHeight);
      setActiveIndex(
        activeHeadingIndex(
          tops,
          scroller.scrollTop,
          scroller.clientHeight,
          scroller.scrollHeight,
          ACTIVATION_OFFSET
        )
      );
    };
    measureRef.current = measure;

    // One frame's delay lets the freshly-set innerHTML lay out before we
    // read offsets.
    const firstRaf = requestAnimationFrame(measure);

    // Observe the content (heading offsets shift as images decode) and
    // the scroller (its height changes when the window resizes even if
    // the content doesn't). Leading-rAF + trailing-debounce coalescing:
    // an isolated reflow (one image, a single Rich-surface edit) still
    // measures on the very next frame, while a burst measures once at the
    // start and once RESIZE_SETTLE_MS after it quiets, instead of once
    // per reflow.
    let leadingRaf: number | null = null;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      // Rail height drives the tick cluster's centering and is cheap to
      // read here (layout is clean inside an observer callback), so it
      // updates eagerly and the cluster tracks a live pane resize
      // frame-by-frame. React bails out of the no-op writes during image
      // bursts, which grow the content, not the scroller.
      setRailHeight(scroller.clientHeight);
      if (leadingRaf == null && trailingTimer == null) {
        leadingRaf = requestAnimationFrame(() => {
          leadingRaf = null;
          measure();
        });
      } else {
        if (trailingTimer) clearTimeout(trailingTimer);
        trailingTimer = setTimeout(() => {
          trailingTimer = null;
          measure();
        }, RESIZE_SETTLE_MS);
      }
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(content);
    ro.observe(scroller);

    // Structural re-renders, for surfaces that reconcile in place. Deferred
    // to the next frame rather than measured inline: the callback fires
    // synchronously from the middle of the reconcile pass, so reading
    // layout there would force a synchronous reflow on an edit — and the
    // freshly-swapped elements haven't been laid out yet anyway. Coalesced,
    // because one pass can rebuild many blocks.
    let structureRaf: number | null = null;
    const unsubscribeStructure = subscribeStructure?.(() => {
      if (structureRaf != null) return;
      structureRaf = requestAnimationFrame(() => {
        structureRaf = null;
        measure();
      });
    });

    return () => {
      cancelAnimationFrame(firstRaf);
      if (leadingRaf != null) cancelAnimationFrame(leadingRaf);
      if (structureRaf != null) cancelAnimationFrame(structureRaf);
      if (trailingTimer) clearTimeout(trailingTimer);
      measureRef.current = null;
      ro.disconnect();
      unsubscribeStructure?.();
    };
  }, [renderKey, scrollerRef, contentRef, subscribeStructure]);

  // Track the active section as the reader scrolls. Cheap: it reuses the
  // cached offsets and only recomputes an index, throttled to a frame.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const tops = headings.map((h) => h.top);
    const onScroll = () => {
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        setActiveIndex(
          activeHeadingIndex(
            tops,
            scroller.scrollTop,
            scroller.clientHeight,
            scroller.scrollHeight,
            ACTIVATION_OFFSET
          )
        );
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [headings, scrollerRef]);

  // Once the pointer and focus have both left, forget any Escape
  // dismissal and reset the keyboard cursor so the next open starts
  // clean and tracks the active section again.
  useEffect(() => {
    if (!hovered && !focused) {
      setDismissed(false);
      setKeyboardNav(false);
    }
  }, [hovered, focused]);

  // Suppressed mid-scrub: a popover sliding in while you drag is noise.
  const open = (hovered || focused) && !dismissed && !scrubbing;

  // Measure the popover once it's open so we can center it on the anchor
  // without overshooting the pane. A layout effect keeps the reposition
  // off-screen (before paint), so there's no visible jump.
  useLayoutEffect(() => {
    if (open && popoverRef.current) {
      setPopoverHeight(popoverRef.current.offsetHeight);
    }
  }, [open, headings.length, railHeight]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  if (headings.length < MIN_HEADINGS || railHeight <= 0) return null;

  const count = headings.length;
  const selectedIndex = keyboardNav ? highlightedIndex : activeIndex;

  // One evenly-spaced, vertically-centered cluster. The gap shrinks from
  // its ideal only when there are enough headings to otherwise overflow
  // the available height, so the cluster always fits and stays centered.
  const available = Math.max(railHeight - VERTICAL_PAD * 2, 0);
  const gap = Math.min(IDEAL_GAP, available / (count - 1));
  const startY = railHeight / 2 - (gap * (count - 1)) / 2;
  const tickY = (index: number) => startY + index * gap;

  // Central by default, nudged a little toward the selected tick, then
  // clamped so a tall card never spills past the pane edges.
  const railCenter = railHeight / 2;
  const desiredCenter =
    railCenter + (tickY(selectedIndex) - railCenter) * POPOVER_DAMP;
  const popoverTop = clamp(
    desiredCenter - popoverHeight / 2,
    POPOVER_PAD,
    Math.max(railHeight - popoverHeight - POPOVER_PAD, POPOVER_PAD)
  );

  const clampIndex = (i: number) => clamp(i, 0, count - 1);

  const scrollToHeading = (index: number) => {
    const scroller = scrollerRef.current;
    const h = headings[index];
    if (!scroller || !h) return;
    // Highlight the target straight away; the scroll-driven recompute
    // settles on the same index once the smooth scroll lands.
    setActiveIndex(index);
    scroller.scrollTo({
      top: Math.max(h.top - SCROLL_MARGIN, 0),
      behavior: 'smooth'
    });
  };

  // Scrub the preview to the vertical fraction the pointer sits at over
  // the rail. Instant (not smooth) so the document tracks the finger;
  // the scroll listener then moves the active-tick highlight along.
  const scrubTo = (clientY: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const frac = clamp((clientY - rect.top) / rect.height, 0, 1);
    const max = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
    scroller.scrollTop = frac * max;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only; let popover rows handle their own clicks.
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('.outline-popover')) return;
    const tick = target.closest('.outline-tick') as HTMLElement | null;
    const tickIndex = tick ? Number(tick.dataset.index) : null;
    pressRef.current = { startY: e.clientY, tickIndex, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press) return; // not a press — hover is handled separately
    if (!press.moved && Math.abs(e.clientY - press.startY) > DRAG_THRESHOLD) {
      press.moved = true;
      setScrubbing(true);
    }
    if (press.moved) scrubTo(e.clientY);
  };

  const releaseCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    releaseCapture(e);
    if (!press) return;
    if (press.moved) {
      setScrubbing(false);
      return;
    }
    // A tap: on a tick, jump to its heading; on the bare track, scrub to
    // that point like clicking a scrollbar gutter.
    if (press.tickIndex != null && !Number.isNaN(press.tickIndex)) {
      scrollToHeading(press.tickIndex);
    } else {
      scrubTo(e.clientY);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    pressRef.current = null;
    setScrubbing(false);
    releaseCapture(e);
  };

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  // Entering the rail (pointer or focus) re-measures just-in-time: a
  // click or popover is likely imminent, and anchor positions must be
  // fresh even if a reflow slipped past the debounced resize path. When
  // nothing moved the measure bails before any state write, so the
  // common case costs one layout read and no render.
  const handleEnter = () => {
    cancelClose();
    measureRef.current?.();
    setHovered(true);
    setDismissed(false);
  };

  const handleLeave = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setHovered(false), CLOSE_GRACE_MS);
  };

  const handleFocus = () => {
    measureRef.current?.();
    setFocused(true);
    setDismissed(false);
  };

  const handleBlur = () => {
    setFocused(false);
  };

  const selectByKeyboard = (index: number) => {
    const next = clampIndex(index);
    setDismissed(false);
    setKeyboardNav(true);
    setHighlightedIndex(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const base = keyboardNav ? highlightedIndex : activeIndex;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectByKeyboard(base + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectByKeyboard(base - 1);
        break;
      case 'Home':
        e.preventDefault();
        selectByKeyboard(0);
        break;
      case 'End':
        e.preventDefault();
        selectByKeyboard(count - 1);
        break;
      case 'Enter':
        e.preventDefault();
        scrollToHeading(base);
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setDismissed(true);
          setKeyboardNav(false);
        }
        break;
      default:
        break;
    }
  };

  return (
    <div
      className="outline-rail"
      role="listbox"
      aria-label={`Document outline, ${count} sections`}
      aria-activedescendant={open ? optionId(selectedIndex) : undefined}
      tabIndex={0}
      data-open={open || undefined}
      data-scrubbing={scrubbing || undefined}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      // A mouse press scrubs the rail; it shouldn't also steal focus, or
      // the focus-driven popover would linger after the drag. Keyboard
      // Tab focus is unaffected by this.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {headings.map((h, i) => (
        <span
          key={h.key}
          className="outline-tick"
          aria-hidden="true"
          data-index={i}
          data-depth={Math.min(h.depth, 6)}
          data-active={i === activeIndex || undefined}
          style={{ top: `${tickY(i)}px` }}
        />
      ))}

      <AnimatePresence>
        {open && (
          <OutlinePopover
            ref={popoverRef}
            style={{ top: popoverTop }}
            headings={headings}
            selectedIndex={selectedIndex}
            activeIndex={activeIndex}
            optionId={optionId}
            onJump={(i) => scrollToHeading(i)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
