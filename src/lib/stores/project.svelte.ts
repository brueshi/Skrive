// The project store — single source of truth for the currently open project,
// the set of open tabs, and the active tab. Every file operation the frontend
// does flows through the methods on `project`.
//
// Shape is tab-based from day one per the A2 decision, but the tab-bar UI
// doesn't exist yet. In Step 1 the debug file list is the only way to open
// tabs, and there's no visible tab bar — the Editor just shows whichever tab
// is currently active.
//
// Persistence is intentionally not implemented here yet. Step 1 keeps state
// in memory only. A follow-up commit adds the `load_project_state` /
// `save_project_state` commands and hooks them in.

import { invoke } from "@tauri-apps/api/core";
import type { FileContent, ProjectManifest, Tab } from "$lib/types";

// Module-level reactive state. Svelte 5 tracks reads through the proxy so
// any component that touches `project.*` subscribes to exactly the fields it
// reads, and re-renders when those fields change.
let manifest = $state<ProjectManifest | null>(null);
let tabs = $state<Tab[]>([]);
let activeTabIndex = $state(-1);

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

  async openProject(path: string): Promise<void> {
    const next = await invoke<ProjectManifest>("open_project", { path });
    manifest = next;
    tabs = [];
    activeTabIndex = -1;
  },

  async openTab(path: string): Promise<void> {
    // If already open, just switch to it. Opening the same file twice should
    // never create duplicate tabs.
    const existing = tabs.findIndex((t) => t.path === path);
    if (existing !== -1) {
      activeTabIndex = existing;
      return;
    }

    const content = await invoke<FileContent>("read_file", { path });
    tabs.push({ path, content, dirty: false });
    activeTabIndex = tabs.length - 1;
  },

  closeTab(index: number): void {
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
    // If activeTabIndex < index, no change needed.
  },

  switchTab(index: number): void {
    if (index < 0 || index >= tabs.length) return;
    activeTabIndex = index;
  },

  /**
   * Called by the editor's onChange when the user types. Updates the active
   * tab's body in place and flags it dirty. No disk write happens here —
   * save is Step 2.
   */
  updateActiveTabContent(body: string): void {
    if (activeTabIndex < 0) return;
    const tab = tabs[activeTabIndex];
    if (!tab) return;
    tab.content.body = body;
    tab.dirty = true;
  },

  closeProject(): void {
    manifest = null;
    tabs = [];
    activeTabIndex = -1;
  },
};
