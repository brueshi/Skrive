// Drag-to-resize (and drag-to-collapse) for the sidebar rail.
//
// The drag is driven imperatively: on every pointer move we write the
// width CSS var straight to the DOM (coalesced to one rAF per frame) and
// only commit to the store on release. Routing each move through React
// state would re-render the whole tree per frame and stutter the drag.
//
// Pointer events here handle *dragging only* (resize + drag-to-collapse).
// Collapse/reveal on a plain click is owned by `toggleFromHandle` on the
// `click` event, because WKWebView doesn't reliably deliver pointerup for a
// motionless press — only the high-level `click` event survives that. The
// drag doesn't engage (no cursor/isDragging) until the pointer actually
// moves past the threshold, so a motionless press leaves no state to clean up.

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useProjectStore
} from '../../stores/project';

const CLICK_MOVE_THRESHOLD_PX = 4;
// Pulling the handle left past this width snaps the sidebar shut. The
// stored width stays put, so re-opening returns to the prior size.
const COLLAPSE_THRESHOLD_PX = 100;

export function useSidebarResize() {
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);
  const setSidebarVisible = useProjectStore((s) => s.setSidebarVisible);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const asideRef = useRef<HTMLElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const rafRef = useRef<number | null>(null);
  const pendingXRef = useRef(0);
  // Last width written during the current drag; committed to the store on
  // release. Stays put when a drag collapses (below the threshold) so
  // re-opening returns to the pre-drag size.
  const dragWidthRef = useRef(sidebarWidth);
  // Tears down the in-flight drag (listeners, rAF, body styles). Stored in a
  // ref so an unmount mid-drag — or the next press — can call it too.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // Set true once a press becomes a real drag, so the `click` that trails a
  // drag doesn't also toggle the sidebar.
  const justDraggedRef = useRef(false);

  const startDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      dragCleanupRef.current?.(); // clear any dangling gesture
      const el = e.currentTarget;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startW = sidebarWidth;
      dragWidthRef.current = sidebarWidth;
      justDraggedRef.current = false;
      let moved = false;

      const cleanup = () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        try {
          el.releasePointerCapture(pointerId);
        } catch {
          // Not captured / already released — ignore.
        }
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragCleanupRef.current = null;
        setIsDragging(false);
      };

      const apply = () => {
        rafRef.current = null;
        const dx = pendingXRef.current - startX;
        if (!moved && Math.abs(dx) <= CLICK_MOVE_THRESHOLD_PX) return;
        if (!moved) {
          // First real movement — engage the drag.
          moved = true;
          justDraggedRef.current = true;
          setIsDragging(true);
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }
        const raw = startW + dx;
        if (raw < COLLAPSE_THRESHOLD_PX) {
          cleanup();
          setSidebarVisible(false); // dragged shut; keep stored width
          return;
        }
        const clamped = Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, raw)
        );
        dragWidthRef.current = clamped;
        asideRef.current?.style.setProperty(
          '--skrive-sidebar-width',
          `${clamped}px`
        );
      };

      function onMove(ev: globalThis.PointerEvent) {
        pendingXRef.current = ev.clientX;
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(apply);
        }
      }
      function onUp() {
        const wasResize = moved;
        cleanup();
        if (wasResize) setSidebarWidth(dragWidthRef.current);
        // A motionless release is a click — onClick handles the toggle.
      }

      try {
        el.setPointerCapture(pointerId);
      } catch {
        // Capture is best-effort; element listeners still fire without it.
      }
      dragCleanupRef.current = cleanup;
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    },
    [sidebarWidth, setSidebarWidth, setSidebarVisible]
  );

  // Click owns collapse/reveal — the one release event WKWebView delivers
  // reliably. Ignores the click that trails a drag (resize / drag-collapse).
  const toggleFromHandle = useCallback(() => {
    dragCleanupRef.current?.();
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    toggleSidebar();
  }, [toggleSidebar]);

  // Safety net: tear down a drag if the component unmounts mid-gesture.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  return { asideRef, isDragging, startDrag, toggleFromHandle };
}
