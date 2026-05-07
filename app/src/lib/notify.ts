// Toast adapter over sonner. Preserves the v0.1.x `notify.error()` API
// shape so call sites don't need to know which library backs the
// surface — Phase 13 UI audit can decide whether to keep this façade or
// inline sonner directly.

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
