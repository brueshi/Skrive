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

import type { EditorView } from 'prosemirror-view';
import type { Command } from 'prosemirror-state';

let activeFlush: (() => void) | null = null;

export function setActiveEditorFlush(flush: (() => void) | null): void {
  activeFlush = flush;
}

/** Push the active surface's pending edit into the store, if any. No-op when
 *  nothing is mounted or nothing is pending. */
export function flushActiveEditor(): void {
  activeFlush?.();
}

// The mounted Rich (ProseMirror) view, registered the same single-slot way as
// the flush above (only one surface is mounted at a time). Lets command sources
// that live outside the editor tree — the ⌘⇧P palette's Insert group — dispatch
// affordance commands into the live view without threading the view through
// React. null whenever the Text surface is active or nothing is open.
let activeRichView: EditorView | null = null;

export function setActiveRichView(view: EditorView | null): void {
  activeRichView = view;
}

export function getActiveRichView(): EditorView | null {
  return activeRichView;
}

/** Dispatch a ProseMirror command into the active Rich view, refocusing it so
 *  the caret stays where the writer expects. Returns false (a no-op) when the
 *  Rich surface isn't mounted or the command doesn't apply. */
export function runRichCommand(cmd: Command): boolean {
  const view = activeRichView;
  if (!view) return false;
  const ran = cmd(view.state, view.dispatch, view);
  if (ran) view.focus();
  return ran;
}
