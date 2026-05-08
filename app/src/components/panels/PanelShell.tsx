// Shared chrome for the three top-right floating panels (frontmatter,
// backlinks, history). Each panel had its own wrapper-with-grid-rows
// trick before; framer-motion's AnimatePresence handles the
// enter/exit transition with a slide-from-top + opacity fade and lets
// the panel unmount cleanly when closed.
//
// Per-panel sizing/positioning still differs (HI is 26rem, FM is 32rem,
// BL is 26rem), so the panel passes a `width` style override and any
// extra class names. Everything else is shared.

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { forwardRef, useEffect, useRef, type ReactNode } from 'react';

type Props = {
  open: boolean;
  ariaLabel: string;
  /** Forwarded to the inner panel for click-outside dismissal in the
   *  parent's effect. */
  panelRef?: React.Ref<HTMLDivElement>;
  /** Extra class on the panel for surface-specific styling (header /
   *  body color tweaks etc). The shell already applies `panel-shell`. */
  className?: string;
  /** CSS width — defaults to 26rem to match the existing chrome. */
  width?: string;
  children: ReactNode;
};

// Entry slides 8px down; exit lifts only 6px. The exit being shallower
// than the entry is deliberate — paired with the opacity fade, the
// panel feels like it's evaporating in place rather than retracting,
// which reads less assertive when the user is dismissing it.
const PANEL_VARIANTS = {
  hidden: { opacity: 0, y: -8 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 }
};

export const PanelShell = forwardRef<HTMLDivElement, Props>(
  function PanelShell(
    { open, ariaLabel, panelRef, className, width = '26rem', children },
    _
  ) {
    const reduced = useReducedMotion();
    const internalRef = useRef<HTMLDivElement | null>(null);

    // Forward the rendered node to both the parent's click-outside ref
    // and our own internal ref (used for the auto-focus effect below).
    function setRef(node: HTMLDivElement | null) {
      internalRef.current = node;
      if (typeof panelRef === 'function') {
        panelRef(node);
      } else if (panelRef) {
        (panelRef as React.MutableRefObject<HTMLDivElement | null>).current =
          node;
      }
    }

    // Move keyboard focus into the panel on open. Without this, a user
    // who hits ⌘⇧F/⌘⇧B/⌘⇧H keeps focus on whatever they had before
    // (typically the editor), so neither Tab navigation nor Escape
    // dismissal works as expected. rAF lets the framer-motion enter
    // transition mount the node first.
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
            className={`panel-shell${className ? ` ${className}` : ''}`}
            style={{ width }}
            ref={setRef}
            role="dialog"
            tabIndex={-1}
            aria-label={ariaLabel}
            initial={reduced ? false : 'hidden'}
            animate="visible"
            exit="exit"
            variants={PANEL_VARIANTS}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: 0.15, ease: [0.4, 0, 0.2, 1] }
            }
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    );
  }
);
