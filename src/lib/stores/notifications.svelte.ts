// Lightweight toast notification store. Replaces the pattern of `console.error`
// on a failure the user can't see — push a toast with the same message so the
// failure is at least visible, then let the user dismiss or ignore.
//
// Deliberately minimal: no variants beyond error/info/success, no action
// buttons, no stacking limits. We have a handful of call sites and a small
// surface — if richer toast UX becomes load-bearing we'll extend, not port
// in a library.

export type NotificationVariant = "error" | "info" | "success";

export type NotificationAction = {
  /** Button label — short, imperative ("Install", "Retry"). */
  label: string;
  /**
   * Fired on click. The notification is dismissed automatically after
   * the callback runs; callers don't need to call `notify.dismiss`.
   */
  onClick: () => void | Promise<void>;
};

export type Notification = {
  id: number;
  message: string;
  variant: NotificationVariant;
  /** Optional call-to-action button. Rendered between message and ×. */
  action?: NotificationAction;
};

// Default auto-dismiss windows per variant. Errors stick longer because
// they usually mean "something went wrong and you should notice" —
// ephemeral info toasts can fade faster. `persistent: true` opts out
// entirely.
const DISMISS_MS: Record<NotificationVariant, number> = {
  error: 6000,
  info: 3000,
  success: 2500,
};

let list = $state<Notification[]>([]);
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

type PushOptions = {
  action?: NotificationAction;
  /** Skip auto-dismiss. Useful for call-to-action toasts (e.g. updater). */
  persistent?: boolean;
};

function pushImpl(
  message: string,
  variant: NotificationVariant,
  opts: PushOptions = {},
): number {
  const trimmed = message.trim();
  if (trimmed.length === 0) return -1;
  const id = nextId++;
  list = [...list, { id, message: trimmed, variant, action: opts.action }];
  if (!opts.persistent) {
    const timer = setTimeout(() => dismissImpl(id), DISMISS_MS[variant]);
    timers.set(id, timer);
  }
  return id;
}

function dismissImpl(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  list = list.filter((n) => n.id !== id);
}

/**
 * Public façade. Call via `notify.error(msg)` etc. from any store, component,
 * or side-effect. The error variant also mirrors the message to the console
 * so developer-tools inspection still works — toasts dismiss themselves,
 * console logs persist.
 */
export const notify = {
  get list() {
    return list;
  },

  error(message: string, cause?: unknown): number {
    if (cause !== undefined) console.error(message, cause);
    return pushImpl(message, "error");
  },
  info(message: string): number {
    return pushImpl(message, "info");
  },
  success(message: string): number {
    return pushImpl(message, "success");
  },
  /**
   * Persistent call-to-action toast. Stays until the user clicks the
   * action or the ×. The action runs, then the toast dismisses.
   * Used for updater prompts, confirmations, and anything else where
   * the toast itself is a decision rather than a passive notice.
   */
  prompt(
    message: string,
    action: NotificationAction,
    variant: NotificationVariant = "info",
  ): number {
    return pushImpl(message, variant, { action, persistent: true });
  },
  dismiss: dismissImpl,
};
