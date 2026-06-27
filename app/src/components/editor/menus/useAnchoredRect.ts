// Position a floating box (selection bubble, link editor, slash menu) against a
// viewport-space rectangle, returning fixed coordinates for a body portal — free
// of the editor's scroll/clip context. The rect-based sibling of the Rich
// surface's use-anchored-box: it takes a plain AnchorRect instead of a PM view +
// doc positions, so it serves both editors (the bespoke surface already hands
// back DOMRects; the Rich adapter builds one from coordsAtPos).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AnchorRect } from './controller';

type Placement = 'above' | 'below';

const GAP = 8;
const MARGIN = 8;

export function useAnchoredRect(
  rect: AnchorRect | null,
  visible: boolean,
  // Bumped by the caller whenever the anchor or the box's own size may have changed
  // (selection geometry, a growing query), to force a re-measure.
  revision: number,
  placement: Placement = 'above'
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    if (!visible || !rect) return;
    const el = ref.current;
    const width = el?.offsetWidth ?? 0;
    const height = el?.offsetHeight ?? 0;
    const center = (rect.left + rect.right) / 2;

    let left = center - width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));

    let top: number;
    if (placement === 'above') {
      top = rect.top - height - GAP;
      if (top < MARGIN) top = rect.bottom + GAP; // flip below
    } else {
      top = rect.bottom + GAP;
      const above = rect.top - height - GAP;
      if (top + height > window.innerHeight - MARGIN && above >= MARGIN) {
        top = above; // flip above when there's no room below
      }
    }
    setPos({ top, left });
  }, [visible, rect, placement]);

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
