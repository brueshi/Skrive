// Position a floating box (selection bubble, link editor, slash menu) against a
// document range, in viewport coordinates so the consumer can render it
// `position: fixed` in a body portal — free of the editor's scroll/clip context.
// Shared so the three overlays anchor, clamp, and re-anchor (on scroll / resize)
// identically.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EditorView } from 'prosemirror-view';

type Placement = 'above' | 'below';

const GAP = 8;
const MARGIN = 8;

export function useAnchoredBox(
  view: EditorView,
  from: number,
  to: number,
  visible: boolean,
  // Bumped by the caller whenever the anchor or the box's own size may have
  // changed (selection geometry, a growing query), to force a re-measure.
  revision: number,
  placement: Placement = 'above'
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    if (!visible) return;
    const el = ref.current;
    const width = el?.offsetWidth ?? 0;
    const height = el?.offsetHeight ?? 0;
    const start = view.coordsAtPos(from);

    let left = start.left - width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));

    let top: number;
    if (placement === 'above') {
      top = start.top - height - GAP;
      if (top < MARGIN) top = view.coordsAtPos(to).bottom + GAP; // flip below
    } else {
      top = view.coordsAtPos(to).bottom + GAP;
      const above = start.top - height - GAP;
      if (top + height > window.innerHeight - MARGIN && above >= MARGIN) {
        top = above; // flip above when there's no room below
      }
    }
    setPos({ top, left });
  }, [visible, view, from, to, placement]);

  // Measure + place synchronously after render so the box paints in position.
  useLayoutEffect(() => {
    reposition();
  }, [reposition, revision]);

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(reposition);
    };
    // Capture phase catches the editor's own scroll container, not just window.
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [visible, reposition]);

  return { ref, pos };
}
