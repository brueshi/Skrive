// The project store — single source of truth for the currently open project,
// the set of open tabs, and the active tab. Every file operation the frontend
// does flows through the methods on `project`.
//
// Shape is tab-based from day one per the A2 decision, but the tab-bar UI
// doesn't exist yet. The debug file list is the only way to open tabs in the
// current iteration.
//
// Pattern note: the methods are defined as standalone helper functions and
// then attached to the `project` object. This lets methods freely call each
// other without `this` binding or circular reference issues.

import { invoke } from "@tauri-apps/api/core";
import type { FileContent, ProjectManifest, Tab } from "$lib/types";

// Module-level reactive state. Svelte 5 tracks reads through the proxy so
// any component that touches `project.*` subscribes to exactly the fields
// it reads and re-renders when those fields change.
let manifest = $state<ProjectManifest | null>(null);
let tabs = $state<Tab[]>([]);
let activeTabIndex = $state(-1);

// =========================== Helper implementations ===========================

async function openProjectImpl(path: string): Promise<void> {
  const next = await invoke<ProjectManifest>("open_project", { path });
  manifest = next;
  tabs = [];
  activeTabIndex = -1;
}

async function openTabImpl(path: string): Promise<void> {
  // If already open, switch to it. Opening the same file twice should never
  // create duplicate tabs.
  const existing = tabs.findIndex((t) => t.path === path);
  if (existing !== -1) {
    activeTabIndex = existing;
    return;
  }

  const content = await invoke<FileContent>("read_file", { path });
  tabs.push({ path, content, dirty: false });
  activeTabIndex = tabs.length - 1;
}

function closeTabImpl(index: number): void {
  if (index < 0 || index >= tabs.length) return;
  // Step 2 will prompt here if the tab is dirty. For now, we drop the edit.
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    activeTabIndex = -1;
  } else if (activeTabIndex > index) {
    // A tab to the left of the active one was removed — keep the active
    // tab visually in place by shifting the index down.
    activeTabIndex -= 1;
  } else if (activeTabIndex === index) {
    // The active tab was removed — fall back to the nearest neighbor.
    activeTabIndex = Math.min(index, tabs.length - 1);
  }
}

function switchTabImpl(index: number): void {
  if (index < 0 || index >= tabs.length) return;
  activeTabIndex = index;
}

/**
 * Called by the editor's onChange when the user types. Updates the active
 * tab's body in place and flags it dirty. No disk write happens here —
 * save is Step 2.
 */
function updateActiveTabContentImpl(body: string): void {
  if (activeTabIndex < 0) return;
  const tab = tabs[activeTabIndex];
  if (!tab) return;
  tab.content.body = body;
  tab.dirty = true;
}

function closeProjectImpl(): void {
  manifest = null;
  tabs = [];
  activeTabIndex = -1;
}

/**
 * Re-scan the current project. Used after creating a new file so the manifest
 * reflects it immediately — once the watcher is wired up in Step 2, this will
 * become unnecessary because watcher events will refresh the file list.
 */
async function refreshManifestImpl(): Promise<void> {
  if (!manifest) return;
  const root = manifest.root;
  const refreshed = await invoke<ProjectManifest>("open_project", { path: root });
  manifest = refreshed;
}

/**
 * Create a new project directory at `{parent}/{name}` and open it. Used by
 * the "Create new project" flow in the empty state.
 */
async function createProjectImpl(parent: string, name: string): Promise<void> {
  const newPath = await invoke<string>("create_directory", { parent, name });
  await openProjectImpl(newPath);
}

/**
 * Create a new empty markdown file inside the currently open project, refresh
 * the manifest, and open it as a tab.
 */
async function createFileImpl(relativePath: string): Promise<void> {
  await invoke<void>("create_file", { path: relativePath });
  await refreshManifestImpl();
  await openTabImpl(relativePath);
}

// =========================== Public API ===========================

export const project = {
  get manifest() {
    return manifest;
  },
  get tabs() {
    return tabs;
  },
  get activeTabIndex() {
    return activeTabIndex;
  },
  get activeTab(): Tab | null {
    if (activeTabIndex < 0) return null;
    return tabs[activeTabIndex] ?? null;
  },
  get hasProject() {
    return manifest !== null;
  },

  openProject: openProjectImpl,
  openTab: openTabImpl,
  closeTab: closeTabImpl,
  switchTab: switchTabImpl,
  updateActiveTabContent: updateActiveTabContentImpl,
  closeProject: closeProjectImpl,
  refreshManifest: refreshManifestImpl,
  createProject: createProjectImpl,
  createFile: createFileImpl,
};
