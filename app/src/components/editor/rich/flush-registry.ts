// The active Rich surface registers its flush here so app-lifecycle code (the
// pre-quit handler in App.tsx) can force its pending, debounced PM->text
// snapshot into the store synchronously before saves run. Without this, an edit
// made inside the snapshot debounce window would still be sitting in PM — not
// the store — when a save fires on quit, and would be lost.
//
// Only one Rich editor is mounted at a time (App keys it by the active tab), so
// a single slot is sufficient.

let activeFlush: (() => void) | null = null;

export function setActiveRichFlush(flush: (() => void) | null): void {
  activeFlush = flush;
}

/** Push the active Rich surface's pending edit into the store, if any. No-op
 *  when the Text surface is active or nothing is pending. */
export function flushActiveRich(): void {
  activeFlush?.();
}
