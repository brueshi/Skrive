// Auto-save driver. Debounces dirty tabs by 1 second of quiet and writes
// them to disk via the Rust `write_file` command.
//
// The driver also owns the suppression window for the save ↔ watcher loop:
//
//   1. User types — tab goes dirty.
//   2. After 1s of quiet, we call `write_file`.
//   3. `write_file` completes. We stamp `lastSavedMs[path] = Date.now()`.
//   4. Milliseconds later, the filesystem watcher emits a `project://file-changed`
//      event for that same path.
//   5. The watcher listener in +page.svelte checks `isRecentSelfWrite(path)`
//      before deciding whether to surface a reload prompt. If the event fell
//      inside the window, it's our own echo and we ignore it.
//
// The window is generous (1500ms) because macOS FSEvents and notify can
// coalesce or delay events a few hundred ms past the syscall return. Missing
// a real external edit by less than two seconds is preferable to yanking
// the user's text out from under them.
//
// Since Phase 2.3 Step 1, a save is `{ body, frontmatter }`, not raw text.
// The body is owned by the editor (CodeMirror); the frontmatter map is
// owned by the frontmatter panel. Both are captured at schedule time so
// the debounced write always flushes a coherent pair.

import { invoke } from "@tauri-apps/api/core";
import { stampAutoFields } from "./autoFields";

const DEBOUNCE_MS = 1000;
const SELF_WRITE_WINDOW_MS = 1500;

type SavePayload = {
  body: string;
  frontmatter: Record<string, unknown>;
};

type PendingSave = {
  timer: ReturnType<typeof setTimeout>;
  payload: SavePayload;
};

const pending = new Map<string, PendingSave>();
const lastSavedMs = new Map<string, number>();

export type AutoSaveHooks = {
  onSaved: (path: string) => void;
  onError: (path: string, err: unknown) => void;
};

async function writeNow(
  path: string,
  payload: SavePayload,
  hooks: AutoSaveHooks,
): Promise<void> {
  try {
    // Refresh last_modified / word_count / reading_time in place. The
    // mutation is by reference and flows through the tab store's proxy
    // so the frontmatter panel reflects the new values immediately.
    stampAutoFields(payload.frontmatter, payload.body);
    await invoke("write_file", {
      path,
      body: payload.body,
      frontmatter: payload.frontmatter,
    });
    lastSavedMs.set(path, Date.now());
    hooks.onSaved(path);
  } catch (err) {
    hooks.onError(path, err);
  }
}

/**
 * Schedule a save for `path`. Called on every keystroke and every
 * frontmatter mutation; only the most recent call within a 1s window
 * actually writes. Subsequent calls replace the pending payload with
 * the newer body/frontmatter pair.
 */
export function scheduleSave(
  path: string,
  payload: SavePayload,
  hooks: AutoSaveHooks,
): void {
  const existing = pending.get(path);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    const entry = pending.get(path);
    if (!entry) return;
    pending.delete(path);
    await writeNow(path, entry.payload, hooks);
  }, DEBOUNCE_MS);

  pending.set(path, { timer, payload });
}

/**
 * Drain any pending save for `path` right now. Used when the user switches
 * files or force-saves via ⌘S. Safe to call for paths that aren't pending.
 */
export async function flushSave(
  path: string,
  hooks: AutoSaveHooks,
): Promise<void> {
  const existing = pending.get(path);
  if (!existing) return;
  clearTimeout(existing.timer);
  pending.delete(path);
  await writeNow(path, existing.payload, hooks);
}

/**
 * True if a watcher event for `path` arriving right now is almost certainly
 * the echo of our own recent `write_file` call. Callers use this to filter
 * the "file changed on disk, reload?" prompt so it only fires for real
 * external edits.
 */
export function isRecentSelfWrite(path: string): boolean {
  const stamp = lastSavedMs.get(path);
  if (stamp === undefined) return false;
  return Date.now() - stamp < SELF_WRITE_WINDOW_MS;
}
