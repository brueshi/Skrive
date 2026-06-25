// Toast adapter over sonner. Preserves the v0.1.x `notify.error()` API
// shape so call sites don't need to know which library backs the
// surface.
//
// Voice convention (set by the Phase 13 audit):
//   - Errors are conversational, not passive: "Couldn't save", not
//     "Failed to save". The writer-first ethos extends to error copy.
//
// Silent-success-on-write is deliberate. Saves, renames, deletes-to-
// trash, and project opens complete without a confirmation toast. A
// writer who just hit ⌘S doesn't need the app to congratulate them;
// the dirty-dot vanishing is the receipt. `success()` is kept on the
// surface for future flows that genuinely need positive confirmation
// (e.g. "Update downloaded — restart to apply") — don't reach for it
// just because something worked. If you find yourself wanting to,
// see planning/react-electron-phase-13-audit.md (PUNT P3).

import {
  createElement,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent
} from 'react';
import { toast } from 'sonner';

export const notify = {
  error(message: string, cause?: unknown): void {
    if (cause !== undefined) console.error(message, cause);
    toast.error(message, { duration: 6000 });
  },
  info(message: string): void {
    toast(message, { duration: 3000 });
  },
  warn(message: string): void {
    toast.warning(message, { duration: 5000 });
  },
  /** Confirms a meaningful event the writer wouldn't otherwise see —
   *  background work completing, an updater step finishing. Don't fire
   *  this on routine writes; see the file header for the silent-
   *  success policy. */
  success(message: string): void {
    toast.success(message, { duration: 2500 });
  },
  /**
   * Persistent call-to-action toast. Stays until the user clicks the
   * action, dismisses it, or swipes it away (sonner enables swipe by
   * default). Used for updater prompts and similar decision-required
   * notices. Unlike the auto-expiring toasts above this never times
   * out, so it carries a corner dismiss control — sonner's `closeButton`
   * slot, repositioned to the top-right and restyled from an X to a dash
   * in index.css (see the `[data-close-button]` overrides).
   */
  prompt(
    message: string,
    actionLabel: string,
    onAction: () => void | Promise<void>
  ): void {
    toast(message, {
      duration: Infinity,
      closeButton: true,
      action: { label: actionLabel, onClick: () => void onAction() }
    });
  },
  /**
   * Two-tier notification card: a small grey eyebrow over a bold headline, in a
   * soft rounded surface with no button or visible close control (see the
   * `.toast-card` rules in index.css). Rendered as a fully custom, `unstyled`
   * sonner toast so none of sonner's default title/description/action/close
   * chrome interferes with the card look. When `onClick` is given the whole
   * card is the affordance — clicking runs it and dismisses — and the toast
   * persists until acted on or swiped away; otherwise it auto-expires.
   */
  card(eyebrow: string, title: string, onClick?: () => void): void {
    const activate = (id: string | number) => {
      onClick?.();
      toast.dismiss(id);
    };
    // Trackpad two-finger swipe fires wheel events, not the pointer-drag that
    // sonner's built-in swipe listens for, so dismiss on a horizontal wheel
    // gesture past a small threshold. Accumulated and reset on a brief idle so
    // ordinary scroll momentum doesn't trip it.
    let wheelAccum = 0;
    let wheelReset: ReturnType<typeof setTimeout> | undefined;
    toast.custom(
      (id) =>
        createElement(
          'div',
          {
            className: 'toast-card',
            onWheel: (e: WheelEvent<HTMLDivElement>) => {
              if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
              wheelAccum += e.deltaX;
              if (wheelReset) clearTimeout(wheelReset);
              wheelReset = setTimeout(() => {
                wheelAccum = 0;
              }, 160);
              if (Math.abs(wheelAccum) > 70) {
                wheelAccum = 0;
                toast.dismiss(id);
              }
            },
            ...(onClick
              ? {
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => activate(id),
                  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate(id);
                    }
                  }
                }
              : {})
          },
          createElement(
            'button',
            {
              type: 'button',
              className: 'toast-card-dismiss',
              'aria-label': 'Dismiss',
              // Stop the card's own onClick from also firing (open Settings).
              onClick: (e: MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                toast.dismiss(id);
              }
            },
            '×'
          ),
          createElement('div', { className: 'toast-card-eyebrow' }, eyebrow),
          createElement('div', { className: 'toast-card-title' }, title)
        ),
      {
        duration: onClick ? Infinity : 6000,
        unstyled: true,
        // Neutralize the Toaster's global wrapper style (bg/border/padding) so
        // the .toast-card div is the only surface; per-toast style wins the
        // merge. Keep a fixed width so the card sizes like the other toasts.
        style: {
          width: '356px',
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
          padding: 0
        }
      }
    );
  }
};
