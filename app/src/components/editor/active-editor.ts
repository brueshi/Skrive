// The active editing surface (CM6 Text or PM Rich) registers its flush here so
// app-lifecycle code can force its pending, debounced snapshot into the store
// synchronously — before an explicit save (⌘S) reads the store, and before the
// app quits.
//
// Both surfaces own their own state and sync to the store on a debounce (the
// "surface owns its state, store gets snapshots" rule that keeps typing from
// round-tripping through React). Without this hook, an edit made inside the
// debounce window would still be in the editor, not the store, when a save
// fires — and would be lost or written stale.
//
// Only one surface is mounted at a time (App keys it by the active tab), so a
// single slot suffices.

let activeFlush: (() => void) | null = null;

export function setActiveEditorFlush(flush: (() => void) | null): void {
  activeFlush = flush;
}

/** Push the active surface's pending edit into the store, if any. No-op when
 *  nothing is mounted or nothing is pending. */
export function flushActiveEditor(): void {
  activeFlush?.();
}
