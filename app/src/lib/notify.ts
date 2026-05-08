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
   * action or dismisses. Used for updater prompts and similar
   * decision-required notices.
   */
  prompt(
    message: string,
    actionLabel: string,
    onAction: () => void | Promise<void>
  ): void {
    toast(message, {
      duration: Infinity,
      action: { label: actionLabel, onClick: () => void onAction() }
    });
  }
};
