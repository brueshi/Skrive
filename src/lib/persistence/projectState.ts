// Frontend wrapper around the Rust persistence commands. Debounces writes
// so a flurry of tab switches or divider drags doesn't thrash the disk, and
// centralizes the conversion between the project store's reactive shape
// and the serialized `ProjectUiState` shape the Rust side expects.
//
// The Rust command names and payload shapes are defined in
// `src-tauri/src/persistence.rs`. Keep the two sides in sync by hand.

import { invoke } from "@tauri-apps/api/core";
import type { ProjectUiState, TabState } from "$lib/types";
import { project } from "$lib/stores/project.svelte";

const DEBOUNCE_MS = 400;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastProjectPath: string | null = null;

/**
 * Load persisted UI state for the given project and apply it to the store.
 * Called right after `openProject` returns so the reopen tabs, sidebar
 * visibility, and per-file layout modes are in place before the user sees
 * the workspace.
 *
 * Files that have been deleted from disk between sessions are silently
 * dropped from the tab list — the Rust `read_file` call errors and we skip.
 */
export async function restoreProjectState(projectPath: string): Promise<void> {
  lastProjectPath = projectPath;
  const state = await invoke<ProjectUiState | null>("load_project_state", {
    projectPath,
  });
  if (!state) return;

  project.setSidebarVisible(state.sidebar.visible);
  project.setSidebarWidth(state.sidebar.width);

  // Reopen tabs one at a time so the store's openTab does its deduping and
  // read_file error handling. We re-apply the layout mode and divider ratio
  // afterward, since openTab resets those to defaults.
  const restored: TabState[] = [];
  for (const saved of state.tabs) {
    try {
      await project.openTab(saved.path);
      const tab = project.tabs.find((t) => t.path === saved.path);
      if (tab) {
        tab.layoutMode =
          saved.layoutMode === "raw" ||
          saved.layoutMode === "split" ||
          saved.layoutMode === "preview"
            ? saved.layoutMode
            : "raw";
        tab.splitDividerRatio = saved.splitDividerRatio;
        restored.push(saved);
      }
    } catch {
      // File no longer exists on disk. Drop it silently. The user will see
      // a smaller tab list than they left behind, which is the right feedback.
    }
  }

  // Active-tab index in the saved file indexes into the original tab list,
  // not the restored one. Walk the restored list to find the saved active
  // tab by path instead of by index.
  const savedActive = state.tabs[state.activeTabIndex];
  if (savedActive) {
    const index = project.tabs.findIndex((t) => t.path === savedActive.path);
    if (index !== -1) project.switchTab(index);
  }
}

/**
 * Queue a persistence write. Called from an effect in +page.svelte whenever
 * any piece of persisted state changes. Debounced so rapid changes collapse
 * into a single disk write.
 */
export function queueSaveProjectState(): void {
  if (!lastProjectPath) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSaveProjectState();
  }, DEBOUNCE_MS);
}

async function flushSaveProjectState(): Promise<void> {
  if (!lastProjectPath) return;
  const manifest = project.manifest;
  if (!manifest) return;

  const projectName = extractProjectName(manifest.root);
  const tabStates: TabState[] = project.tabs.map((t) => {
    // Diff mode is session-only — it evaporates on project close, so
    // persistence records the editor mode the tab would return to on
    // exit (`t.diff.restoreMode`) instead of the diff variant itself.
    const layoutMode: "raw" | "split" | "preview" =
      t.layoutMode === "diff-raw"
        ? "raw"
        : t.layoutMode === "diff-preview"
          ? "preview"
          : t.layoutMode;
    return {
      path: t.path,
      layoutMode,
      cursor: { line: 0, column: 0 },
      scrollTop: 0,
      splitDividerRatio: t.splitDividerRatio,
    };
  });

  const state: ProjectUiState = {
    schemaVersion: 1,
    projectPath: lastProjectPath,
    projectName,
    lastOpenedMs: Date.now(),
    sidebar: {
      visible: project.sidebarVisible,
      width: project.sidebarWidth,
    },
    tabs: tabStates,
    activeTabIndex: project.activeTabIndex,
  };

  try {
    await invoke("save_project_state", {
      projectPath: lastProjectPath,
      uiState: state,
    });
  } catch (err) {
    console.warn("Failed to save project UI state:", err);
  }
}

/**
 * Clear the cached project path. Called when the project is closed so
 * pending saves don't resurrect a path we no longer care about.
 */
export function resetProjectStateTarget(): void {
  lastProjectPath = null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function extractProjectName(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}
