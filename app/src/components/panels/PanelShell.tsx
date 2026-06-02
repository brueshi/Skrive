// Shared chrome for the three side panels (frontmatter, backlinks,
// history). Skrive 1.0 docks them: instead of floating over the editor,
// the open panel is an in-flow card to the right of the workspace, and
// the editor narrows to make room (one panel at a time — the store's
// mutex still guarantees that).
//
// The dock animates its own width (a right-anchored drawer reveal) so
// the editor reflows smoothly as it opens and closes. The inner card
// keeps a fixed width and is absolutely anchored to the dock's right
// edge, so its content never reflows mid-animation — the clip just
// uncovers it from the right. AnimatePresence drives the open/exit and
// unmounts the panel when closed.
//
// Per-panel width still differs (FM is 32rem, BL/HI 26rem), passed as
// `widthRem`.

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { forwardRef, useEffect, useRef, type ReactNode } from 'react';

type Props = {
  open: boolean;
  ariaLabel: string;
  /** Forwarded to the inner panel for focus management in the parent. */
  panelRef?: React.Ref<HTMLDivElement>;
  /** Extra class on the inner card for surface-specific styling. */
  className?: string;
  /** Card width in rem — defaults to 26 to match the existing chrome. */
  widthRem?: number;
  children: ReactNode;
};

/** :root sets font-size: 14px, so 1rem = 14px. The dock animates a px
 *  width, so resolve the rem here rather than animate a unit expression. */
const ROOT_FONT_PX = 14;

export const PanelShell = forwardRef<HTMLDivElement, Props>(
  function PanelShell(
    { open, ariaLabel, panelRef, className, widthRem = 26, children },
    _
  ) {
    const reduced = useReducedMotion();
    const internalRef = useRef<HTMLDivElement | null>(null);
    const widthPx = widthRem * ROOT_FONT_PX;

    function setRef(node: HTMLDivElement | null) {
      internalRef.current = node;
      if (typeof panelRef === 'function') {
        panelRef(node);
      } else if (panelRef) {
        (panelRef as React.MutableRefObject<HTMLDivElement | null>).current =
          node;
      }
    }

    // Move keyboard focus into the panel on open so Tab navigation and
    // Escape work without an extra click. rAF lets the enter transition
    // mount the node first.
    useEffect(() => {
      if (!open) return;
      const id = requestAnimationFrame(() => {
        internalRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }, [open]);

    return (
      <AnimatePresence>
        {open && (
          <motion.div
            className="panel-dock"
            initial={reduced ? false : { width: 0, opacity: 0 }}
            animate={{ width: widthPx, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }
            }
          >
            <div
              className={`panel-shell${className ? ` ${className}` : ''}`}
              style={{ width: widthPx }}
              ref={setRef}
              role="dialog"
              tabIndex={-1}
              aria-label={ariaLabel}
            >
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }
);
