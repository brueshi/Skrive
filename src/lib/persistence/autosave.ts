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
  /**
   * Fired when the auto-save driver rewrote a tab's body on its way to
   * disk — currently the only caller is the leading-frontmatter extraction
   * path, which pulls a typed `---` block out of the body and into the
   * frontmatter map. The store implements this to update the tab's body
   * so the editor re-renders with the shrunken content.
   */
  onBodyRewritten?: (path: string, newBody: string) => void;
};

type ExtractedFrontmatter = {
  frontmatter: Record<string, unknown>;
  body: string;
};

function mightHaveLeadingFrontmatter(body: string): boolean {
  // Rust's `frontmatter::parse` requires the `---` to be at byte zero
  // followed by a newline (LF or CRLF). We mirror that prefix check here
  // so we can skip the IPC round-trip for every body that obviously isn't
  // a frontmatter candidate.
  return body.startsWith("---\n") || body.startsWith("---\r\n");
}

async function writeNow(
  path: string,
  payload: SavePayload,
  hooks: AutoSaveHooks,
): Promise<void> {
  try {
    // If the tab has no frontmatter yet and the body appears to start
    // with a `---` fence, ask the Rust core to peel a leading YAML block
    // off the body and fold it into the frontmatter map. This absorbs
    // frontmatter that the user typed or pasted directly into the editor
    // (the natural authoring flow) so the structured subsystem takes
    // ownership of it at save time. Bodies without a fence, invalid YAML,
    // or tabs that already have frontmatter skip this path.
    if (
      Object.keys(payload.frontmatter).length === 0 &&
      mightHaveLeadingFrontmatter(payload.body)
    ) {
      const extracted = await invoke<ExtractedFrontmatter | null>(
        "try_extract_frontmatter",
        { content: payload.body },
      );
      if (extracted) {
        payload.body = extracted.body;
        for (const [k, v] of Object.entries(extracted.frontmatter)) {
          payload.frontmatter[k] = v;
        }
        hooks.onBodyRewritten?.(path, extracted.body);
      }
    }

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
 * Drain every pending save. Called from the window-close handler so a
 * keystroke hit within the 1-second debounce window still makes it to
 * disk before the app exits.
 */
export async function flushAllPendingSaves(
  hooks: AutoSaveHooks,
): Promise<void> {
  const paths = Array.from(pending.keys());
  await Promise.all(paths.map((p) => flushSave(p, hooks)));
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

/**
 * Stamp `path` as having been written by us just now. Feeds the same
 * `isRecentSelfWrite` table autosave uses, but exposed so non-save code
 * paths (Phase 3.1's rename-with-references, future batch writes) can
 * keep the watcher's echo filter honest without pretending to be a save.
 *
 * Callers should stamp *both* the path they're about to touch and any
 * path that will transiently be affected — for rename, that's the old
 * path (which fires a Remove event on most platforms) and the new path
 * (Create), plus every rewritten file (Modify).
 */
export function markRecentSelfWrite(path: string): void {
  lastSavedMs.set(path, Date.now());
}
