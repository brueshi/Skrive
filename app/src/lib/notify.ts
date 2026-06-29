// Toast adapter over sonner. Preserves the v0.1.x `notify.error()` API
// shape so call sites don't need to know which library backs the
// surface.
//
// Every variant now renders through one custom card renderer (`showCard`)
// so the whole toast surface is uniform: the same rounded card, eyebrow/
// title type, in-card dismiss, and swipe-to-dismiss the updater card
// introduced. sonner only positions and animates the wrapper — none of its
// default title/description/action/close chrome is used anymore. A single
// restrained `danger` tone marks attention states (errors, warnings); calm
// states (info/success/prompts/cards) carry no color, the copy does the work.
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
  type ReactNode,
  type WheelEvent
} from 'react';
import { toast } from 'sonner';

type Tone = 'neutral' | 'danger';

interface ShowCardOptions {
  /** Small grey label above the headline. Omitted for plain messages. */
  eyebrow?: string;
  /** The headline — the main message. */
  title: string;
  /** `danger` draws a quiet attention accent; `neutral` (default) is calm. */
  tone?: Tone;
  /** ms, or Infinity. Defaults: persistent toasts never expire; otherwise
   *  the caller's value. */
  duration?: number;
  /** Makes the whole card the affordance — clicking runs it and dismisses.
   *  Mutually exclusive with `action`. */
  onClick?: () => void;
  /** A labeled button inside the card. Persists until acted on or dismissed.
   *  Mutually exclusive with `onClick`. */
  action?: { label: string; run: () => void | Promise<void> };
}

// Matches the other toasts' width so cards line up in the stack.
const CARD_WIDTH = '356px';

// The Toaster's global wrapper style (bg/border/padding) would otherwise show
// through the custom card; null it out so `.toast-card` is the only surface.
const UNSTYLE_WRAPPER = {
  width: CARD_WIDTH,
  background: 'transparent',
  border: 'none',
  boxShadow: 'none',
  padding: 0
} as const;

function showCard(opts: ShowCardOptions): void {
  const { eyebrow, title, tone = 'neutral', onClick, action } = opts;
  const persistent = onClick != null || action != null;
  const duration = opts.duration ?? (persistent ? Infinity : 4000);

  toast.custom(
    (id) => {
      const activate = () => {
        onClick?.();
        toast.dismiss(id);
      };

      // Trackpad two-finger swipe fires wheel events, not the pointer-drag
      // sonner's built-in swipe listens for, so dismiss on a horizontal wheel
      // gesture past a small threshold. Accumulated and reset on a brief idle
      // so ordinary scroll momentum doesn't trip it. Closed over per render.
      let wheelAccum = 0;
      let wheelReset: ReturnType<typeof setTimeout> | undefined;
      const onWheel = (e: WheelEvent<HTMLDivElement>) => {
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
      };

      const children: ReactNode[] = [
        // In-card dismiss — a quiet control in the top-right corner.
        createElement(
          'button',
          {
            key: 'dismiss',
            type: 'button',
            className: 'toast-card-dismiss',
            'aria-label': 'Dismiss',
            // Stop the card's own onClick from also firing.
            onClick: (e: MouseEvent<HTMLButtonElement>) => {
              e.stopPropagation();
              toast.dismiss(id);
            }
          },
          '×'
        )
      ];
      if (eyebrow) {
        children.push(
          createElement('div', { key: 'eyebrow', className: 'toast-card-eyebrow' }, eyebrow)
        );
      }
      children.push(
        createElement('div', { key: 'title', className: 'toast-card-title' }, title)
      );
      if (action) {
        children.push(
          createElement(
            'button',
            {
              key: 'action',
              type: 'button',
              className: 'toast-card-action',
              onClick: (e: MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                void action.run();
                toast.dismiss(id);
              }
            },
            action.label
          )
        );
      }

      const clickable = onClick != null;
      return createElement(
        'div',
        {
          className: `toast-card${tone === 'danger' ? ' tone-danger' : ''}`,
          onWheel,
          ...(clickable
            ? {
                role: 'button',
                tabIndex: 0,
                onClick: activate,
                onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activate();
                  }
                }
              }
            : {})
        },
        children
      );
    },
    { duration, unstyled: true, style: UNSTYLE_WRAPPER }
  );
}

export const notify = {
  error(message: string, cause?: unknown): void {
    if (cause !== undefined) console.error(message, cause);
    showCard({ title: message, tone: 'danger', duration: 6000 });
  },
  info(message: string): void {
    showCard({ title: message, duration: 3000 });
  },
  warn(message: string): void {
    showCard({ title: message, tone: 'danger', duration: 5000 });
  },
  /** Confirms a meaningful event the writer wouldn't otherwise see —
   *  background work completing, an updater step finishing. Don't fire
   *  this on routine writes; see the file header for the silent-
   *  success policy. */
  success(message: string): void {
    showCard({ title: message, duration: 2500 });
  },
  /**
   * Persistent call-to-action toast with a labeled action button. Stays until
   * the writer clicks the action, dismisses it, or swipes it away. Used for
   * updater prompts, the feedback nudge, and the disk-conflict overwrite —
   * decisions that need an explicit verb rather than a whole-card click.
   */
  prompt(
    message: string,
    actionLabel: string,
    onAction: () => void | Promise<void>
  ): void {
    showCard({ title: message, action: { label: actionLabel, run: onAction } });
  },
  /**
   * Two-tier notification card: a small grey eyebrow over a bold headline. When
   * `onClick` is given the whole card is the affordance — clicking runs it and
   * dismisses — and the toast persists until acted on or swiped away; otherwise
   * it auto-expires. Used by the updater for "Update available" / "Ready to
   * install" prompts that open Settings.
   */
  card(eyebrow: string, title: string, onClick?: () => void): void {
    showCard({ eyebrow, title, onClick, duration: onClick ? Infinity : 6000 });
  }
};
