// Project-level actions shared between keyboard shortcuts and menu
// items. These sit outside the `project` store because they orchestrate
// the store plus the directory picker plus user-facing error surfacing —
// the store itself stays I/O-pure.

import { project } from "$lib/stores/project.svelte";
import { preferences } from "$lib/stores/preferences.svelte";
import { pickProjectDirectory } from "$lib/dialog";
import { notify } from "$lib/stores/notifications.svelte";
import { flushAllPendingSaves } from "$lib/persistence/autosave";
import { formatError } from "$lib/errors";

/**
 * Pop the system directory picker and, if the user picks a folder,
 * open it as the active project. Silently no-ops on cancel. Errors are
 * surfaced as toasts.
 */
export async function openProjectFromPicker(): Promise<void> {
  try {
    const path = await pickProjectDirectory();
    if (!path) return;
    await project.openProject(path);
  } catch (err) {
    notify.error(`Couldn't open project: ${formatError(err)}`, err);
  }
}

/**
 * Flush any pending autosaves, then close the currently open project.
 * The user lands back on the empty state. Dirty tab content has
 * already been written to disk by the time we clear the in-memory
 * tabs, so the standard "no confirmation on close" rule holds.
 */
export async function closeCurrentProject(
  autoSaveHooks: {
    onSaved: (path: string) => void;
    onError: (path: string, err: unknown) => void;
  },
): Promise<void> {
  if (!project.hasProject) return;
  try {
    await flushAllPendingSaves(autoSaveHooks);
  } catch (err) {
    // A failed flush is already a toast from the hook; we still close
    // so the user isn't trapped in a broken state.
    console.warn("Flush on close-project failed:", err);
  }
  project.closeProject();
}

/**
 * Open a specific project by path — used by the Recent Projects menu
 * entries. If the path is gone, surface the error and prune the entry
 * from the recent list so the next menu open doesn't offer it again.
 */
export async function openRecentProject(path: string): Promise<void> {
  try {
    await project.openProject(path);
  } catch (err) {
    notify.error(`Couldn't open ${path}: ${formatError(err)}`, err);
    preferences.removeRecentProject(path);
  }
}
