// The project store — zustand, single source of truth for the open
// project, the open tabs, the active tab, and sidebar visibility/width.
//
// Phase 4 swaps the single-active-file model from Phase 3 for the tabs
// layer. Each tab carries its own layoutMode + splitDividerRatio so that
// switching files restores the view the user last had on that file.
//
// Per-project tab persistence wires through Phase 9 (state model A3).
// For now tabs reset on app restart.

import { create } from 'zustand';
import type {
  FileEntry,
  FrontmatterMap,
  ProjectChange,
  ProjectLintReport,
  ProjectManifest
} from '@skrive/shared';
import type { LayoutMode } from '../components/editor/SplitView';
import {
  mightHaveLeadingFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
  stampAutoFields
} from '../lib/frontmatter';
import { runProjectLint } from '../lib/lint';
import { notify } from '../lib/notify';

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 260;

const DEFAULT_LAYOUT_MODE: LayoutMode = 'split';
const DEFAULT_SPLIT_RATIO = 0.5;

export type Tab = {
  path: string;
  /** Body without the leading frontmatter block. The editor reads/writes
   *  this; the full file is reassembled at save time. */
  body: string;
  /** Parsed YAML frontmatter for the file. Populated on openTab; mutated
   *  by the FrontmatterPanel; auto-stamped fields refreshed on save. */
  frontmatter: FrontmatterMap;
  dirty: boolean;
  layoutMode: LayoutMode;
  splitDividerRatio: number;
};

type State = {
  manifest: ProjectManifest | null;
  tabs: Tab[];
  activeTabIndex: number;
  loading: boolean;

  sidebarVisible: boolean;
  sidebarWidth: number;

  /** Floating top-right backlinks panel (phase 6). Toggled from the
   *  Header; reads `linkGraph.getBacklinks(activeTab.path)` on open. */
  backlinksPanelOpen: boolean;

  /** Floating top-right frontmatter editor (phase 7). Toggled from the
   *  Header's FM·N indicator or via ⌘⇧F. Mutually exclusive with the
   *  backlinks panel — opening one closes the other. */
  frontmatterPanelOpen: boolean;

  /** Most recent project-wide lint report. Refreshed after open and
   *  after any watcher event resolves. Null between project loads.
   *
   *  Phase 8 ships gutter markers as the only UI surface; the
   *  project-wide panel is deferred to v0.3+. The report is computed
   *  centrally so a future panel can consume the same shape without
   *  re-running the engine. */
  lintReport: ProjectLintReport | null;

  unsubscribeWatch: (() => void) | null;
};

type Actions = {
  openProjectFromDialog(): Promise<void>;
  openProject(path: string): Promise<void>;
  closeProject(): Promise<void>;
  refreshManifest(): Promise<void>;

  openTab(path: string): Promise<void>;
  closeTab(index: number): Promise<void>;
  switchTab(index: number): void;

  setTabBody(index: number, next: string): void;
  setTabLayoutMode(index: number, mode: LayoutMode): void;
  setTabSplitRatio(index: number, ratio: number): void;

  saveActiveTab(): Promise<void>;
  saveAllDirty(): Promise<void>;

  createFile(relPath: string): Promise<void>;
  createDirectory(relPath: string): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
  deleteDirectory(relPath: string): Promise<void>;

  setSidebarVisible(v: boolean): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;

  setBacklinksPanelOpen(v: boolean): void;
  toggleBacklinksPanel(): void;

  setFrontmatterPanelOpen(v: boolean): void;
  toggleFrontmatterPanel(): void;
  closeFrontmatterPanel(): void;

  /** Re-run the lint engine against the current manifest + open tabs.
   *  Pulls deadLinks + orphanedFiles fresh from IPC. Safe to call when
   *  no project is open (no-op). */
  refreshLint(): Promise<void>;

  /** Replace the value of a frontmatter field on the active tab. New
   *  fields are inserted at the end of the map; existing fields are
   *  updated in place (preserving order on the wire). */
  updateActiveTabFrontmatter(key: string, value: unknown): void;
  /** Remove a frontmatter field from the active tab. */
  removeActiveTabFrontmatter(key: string): void;
  /** Rename a frontmatter key on the active tab. Silently no-ops on
   *  conflict — the panel's commitKey detects the no-op and reverts the
   *  input back to the original key. */
  renameActiveTabFrontmatterKey(oldKey: string, newKey: string): void;
};

function clampSidebarWidth(w: number): number {
  if (Number.isNaN(w)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w));
}

function clampRatio(r: number): number {
  if (Number.isNaN(r)) return DEFAULT_SPLIT_RATIO;
  return Math.min(Math.max(r, 0.15), 0.85);
}

function findEntry(
  manifest: ProjectManifest | null,
  path: string
): FileEntry | null {
  if (!manifest) return null;
  return manifest.files.find((f) => f.path === path) ?? null;
}

/**
 * Build the on-disk file contents for a tab. Re-stamps auto-fields,
 * absorbs any leading `---` block the user typed straight into the
 * editor body into the structured map, and concatenates the serialized
 * frontmatter with the body. Mutates `tab.frontmatter` and `tab.body`
 * if absorption happened so the panel reflects the absorbed fields.
 */
function buildSavePayload(tab: Tab): string {
  // Absorb a leading frontmatter block the user typed into the editor.
  // Only attempts this when the structured map is currently empty —
  // otherwise we'd be silently merging two sources of truth.
  if (
    Object.keys(tab.frontmatter).length === 0 &&
    mightHaveLeadingFrontmatter(tab.body)
  ) {
    const extracted = parseFrontmatter(tab.body);
    if (Object.keys(extracted.frontmatter).length > 0) {
      tab.frontmatter = extracted.frontmatter;
      tab.body = extracted.body;
    }
  }
  stampAutoFields(tab.frontmatter, tab.body);
  return serializeFrontmatter(tab.frontmatter) + tab.body;
}

export const useProjectStore = create<State & Actions>((set, get) => ({
  manifest: null,
  tabs: [],
  activeTabIndex: -1,
  loading: false,

  sidebarVisible: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,

  backlinksPanelOpen: false,
  frontmatterPanelOpen: false,
  lintReport: null,

  unsubscribeWatch: null,

  // ============================ Project ============================

  async openProjectFromDialog() {
    const path = await window.skrive.project.openDialog();
    if (!path) return;
    await get().openProject(path);
  },

  async openProject(path: string) {
    set({ loading: true });
    try {
      const prev = get().unsubscribeWatch;
      if (prev) prev();
      await window.skrive.project.unwatch();

      const manifest = await window.skrive.project.open(path);

      const unsubscribe = window.skrive.project.onChange((event) => {
        if (event.kind === 'ready') return;
        void get().refreshManifest();
      });
      await window.skrive.project.watch(manifest.root);

      set({
        manifest,
        tabs: [],
        activeTabIndex: -1,
        lintReport: null,
        unsubscribeWatch: unsubscribe,
        loading: false
      });
      // Surface .skrive.toml warnings once per open. Live reload is
      // a documented post-port follow-up; reopen the project to apply
      // edits and re-trigger validation.
      for (const warning of manifest.warnings) {
        notify.warn(warning);
      }
      void get().refreshLint();
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  async closeProject() {
    const prev = get().unsubscribeWatch;
    if (prev) prev();
    await window.skrive.project.unwatch();
    // Flush any dirty tabs first.
    await get().saveAllDirty();
    set({
      manifest: null,
      tabs: [],
      activeTabIndex: -1,
      lintReport: null,
      unsubscribeWatch: null
    });
  },

  async refreshManifest() {
    const manifest = get().manifest;
    if (!manifest) return;
    const next = await window.skrive.project.open(manifest.root);
    set({ manifest: next });
    // Re-run lint after any manifest refresh — covers save events
    // (which trigger the watcher) and direct fs operations.
    void get().refreshLint();
    // Drop tabs whose files vanished from disk.
    const { tabs, activeTabIndex } = get();
    const survivingTabs = tabs.filter((t) =>
      next.files.some((f) => f.path === t.path)
    );
    if (survivingTabs.length !== tabs.length) {
      let nextActive = activeTabIndex;
      // If the active tab survived, find its new index. Otherwise step
      // back to the previous tab (or to -1 when none left).
      const wasActive = tabs[activeTabIndex];
      if (wasActive) {
        const i = survivingTabs.findIndex((t) => t.path === wasActive.path);
        nextActive = i;
      } else {
        nextActive = Math.min(activeTabIndex, survivingTabs.length - 1);
      }
      set({ tabs: survivingTabs, activeTabIndex: nextActive });
    }
  },

  // ============================ Tabs ============================

  async openTab(path: string) {
    const manifest = get().manifest;
    if (!manifest) return;
    const entry = findEntry(manifest, path);
    if (!entry) return;
    const tabs = get().tabs;
    const existingIndex = tabs.findIndex((t) => t.path === path);
    if (existingIndex !== -1) {
      set({ activeTabIndex: existingIndex });
      return;
    }
    // Read body fresh from disk for the new tab. Parse the leading
    // frontmatter so the editor sees the body sans-fence and the panel
    // sees the structured map. The full file is reassembled at save time.
    const content = await window.skrive.fs.readFile(manifest.root, path);
    const parsed = parseFrontmatter(content.body);
    const newTab: Tab = {
      path,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      dirty: false,
      layoutMode: DEFAULT_LAYOUT_MODE,
      splitDividerRatio: DEFAULT_SPLIT_RATIO
    };
    const nextTabs = [...tabs, newTab];
    set({ tabs: nextTabs, activeTabIndex: nextTabs.length - 1 });
  },

  async closeTab(index: number) {
    const { tabs, activeTabIndex } = get();
    const tab = tabs[index];
    if (!tab) return;
    if (tab.dirty) {
      // Best-effort flush before discard. Errors surface via the caller's
      // error path; the close still proceeds so the user isn't trapped.
      try {
        const writableTab: Tab = { ...tab, frontmatter: { ...tab.frontmatter } };
        const payload = buildSavePayload(writableTab);
        await window.skrive.fs.writeFile(
          get().manifest!.root,
          tab.path,
          payload
        );
      } catch (err) {
        console.error('[skrive] save-on-close failed', err);
      }
    }
    const nextTabs = tabs.slice(0, index).concat(tabs.slice(index + 1));
    let nextActive = activeTabIndex;
    if (nextTabs.length === 0) {
      nextActive = -1;
    } else if (index < activeTabIndex) {
      nextActive = activeTabIndex - 1;
    } else if (index === activeTabIndex) {
      nextActive = Math.min(activeTabIndex, nextTabs.length - 1);
    }
    set({ tabs: nextTabs, activeTabIndex: nextActive });
  },

  switchTab(index: number) {
    const { tabs } = get();
    if (index < 0 || index >= tabs.length) return;
    set({ activeTabIndex: index });
  },

  setTabBody(index: number, next: string) {
    const { tabs } = get();
    const tab = tabs[index];
    if (!tab) return;
    if (next === tab.body) return;
    const updated = { ...tab, body: next, dirty: true };
    const nextTabs = tabs.slice();
    nextTabs[index] = updated;
    set({ tabs: nextTabs });
  },

  setTabLayoutMode(index: number, mode: LayoutMode) {
    const { tabs } = get();
    const tab = tabs[index];
    if (!tab || tab.layoutMode === mode) return;
    const nextTabs = tabs.slice();
    nextTabs[index] = { ...tab, layoutMode: mode };
    set({ tabs: nextTabs });
  },

  setTabSplitRatio(index: number, ratio: number) {
    const { tabs } = get();
    const tab = tabs[index];
    if (!tab) return;
    const clamped = clampRatio(ratio);
    if (tab.splitDividerRatio === clamped) return;
    const nextTabs = tabs.slice();
    nextTabs[index] = { ...tab, splitDividerRatio: clamped };
    set({ tabs: nextTabs });
  },

  async saveActiveTab() {
    const { manifest, tabs, activeTabIndex } = get();
    const tab = tabs[activeTabIndex];
    if (!manifest || !tab || !tab.dirty) return;
    // Clone before stamping so the live tab object isn't mutated mid-render.
    const writable: Tab = { ...tab, frontmatter: { ...tab.frontmatter } };
    const payload = buildSavePayload(writable);
    await window.skrive.fs.writeFile(manifest.root, tab.path, payload);
    const nextTabs = tabs.slice();
    nextTabs[activeTabIndex] = {
      ...writable,
      dirty: false
    };
    set({ tabs: nextTabs });
  },

  async saveAllDirty() {
    const { manifest, tabs } = get();
    if (!manifest) return;
    const dirtyIndices: number[] = [];
    const writes: Array<Promise<void>> = [];
    const updatedTabs = tabs.slice();
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (!t || !t.dirty) continue;
      const writable: Tab = { ...t, frontmatter: { ...t.frontmatter } };
      const payload = buildSavePayload(writable);
      dirtyIndices.push(i);
      updatedTabs[i] = { ...writable, dirty: false };
      writes.push(window.skrive.fs.writeFile(manifest.root, t.path, payload));
    }
    if (writes.length === 0) return;
    await Promise.all(writes);
    set({ tabs: updatedTabs });
  },

  // ============================ File CRUD ============================

  async createFile(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    const normalized = relPath.endsWith('.md') ? relPath : `${relPath}.md`;
    await window.skrive.fs.newFile(manifest.root, normalized);
    await get().refreshManifest();
    await get().openTab(normalized);
  },

  async createDirectory(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    await window.skrive.fs.mkdir(manifest.root, relPath);
  },

  async deleteFile(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    await window.skrive.fs.trash(manifest.root, relPath);
    // Close any tab pointing at the deleted file. The watcher's unlink
    // event will also fire and trigger refreshManifest, but explicitly
    // closing here keeps the tab list responsive.
    const tabs = get().tabs;
    const i = tabs.findIndex((t) => t.path === relPath);
    if (i !== -1) {
      const next = tabs.slice(0, i).concat(tabs.slice(i + 1));
      const { activeTabIndex } = get();
      let nextActive = activeTabIndex;
      if (next.length === 0) nextActive = -1;
      else if (i < activeTabIndex) nextActive = activeTabIndex - 1;
      else if (i === activeTabIndex)
        nextActive = Math.min(activeTabIndex, next.length - 1);
      set({ tabs: next, activeTabIndex: nextActive });
    }
    await get().refreshManifest();
  },

  async deleteDirectory(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    await window.skrive.fs.trash(manifest.root, relPath);
    // Drop any tabs inside the deleted directory.
    const prefix = relPath.endsWith('/') ? relPath : `${relPath}/`;
    const tabs = get().tabs;
    const survivors = tabs.filter((t) => !t.path.startsWith(prefix));
    if (survivors.length !== tabs.length) {
      const { activeTabIndex } = get();
      const wasActive = tabs[activeTabIndex];
      let nextActive = activeTabIndex;
      if (wasActive) {
        const i = survivors.findIndex((t) => t.path === wasActive.path);
        nextActive = i === -1 ? Math.min(activeTabIndex, survivors.length - 1) : i;
      }
      set({ tabs: survivors, activeTabIndex: nextActive });
    }
    await get().refreshManifest();
  },

  // ============================ Sidebar ============================

  setSidebarVisible(v: boolean) {
    set({ sidebarVisible: v });
  },

  toggleSidebar() {
    set({ sidebarVisible: !get().sidebarVisible });
  },

  setSidebarWidth(width: number) {
    set({ sidebarWidth: clampSidebarWidth(width) });
  },

  // ============================ Backlinks panel ============================

  setBacklinksPanelOpen(v: boolean) {
    if (v) {
      set({ backlinksPanelOpen: true, frontmatterPanelOpen: false });
    } else {
      set({ backlinksPanelOpen: false });
    }
  },

  toggleBacklinksPanel() {
    const next = !get().backlinksPanelOpen;
    if (next) {
      set({ backlinksPanelOpen: true, frontmatterPanelOpen: false });
    } else {
      set({ backlinksPanelOpen: false });
    }
  },

  // ============================ Frontmatter panel ============================

  setFrontmatterPanelOpen(v: boolean) {
    if (v) {
      set({ frontmatterPanelOpen: true, backlinksPanelOpen: false });
    } else {
      set({ frontmatterPanelOpen: false });
    }
  },

  toggleFrontmatterPanel() {
    const next = !get().frontmatterPanelOpen;
    if (next) {
      set({ frontmatterPanelOpen: true, backlinksPanelOpen: false });
    } else {
      set({ frontmatterPanelOpen: false });
    }
  },

  closeFrontmatterPanel() {
    set({ frontmatterPanelOpen: false });
  },

  // ============================ Lint ============================

  async refreshLint() {
    const manifest = get().manifest;
    if (!manifest) {
      if (get().lintReport !== null) set({ lintReport: null });
      return;
    }
    try {
      const [deadLinks, orphanedFiles] = await Promise.all([
        window.skrive.linkGraph.getDeadLinks(),
        window.skrive.linkGraph.getOrphanedFiles()
      ]);
      // Build the body map from open tabs so unsaved edits are linted
      // against the editor content, not the on-disk version. Files not
      // currently open fall back to disk during the engine's per-file
      // pass — the engine treats missing entries as empty bodies, which
      // is a no-op for the single-file rules. Cross-file rules don't
      // depend on bodies here (links + orphans come from IPC).
      const bodies = new Map<string, string>();
      for (const tab of get().tabs) {
        bodies.set(tab.path, tab.body);
      }
      // For files not in tabs, read from disk so per-file rules
      // (heading hierarchy, duplicate headings) cover the whole project.
      for (const file of manifest.files) {
        if (bodies.has(file.path)) continue;
        try {
          const content = await window.skrive.fs.readFile(
            manifest.root,
            file.path
          );
          bodies.set(file.path, parseFrontmatter(content.body).body);
        } catch {
          // File vanished mid-scan; leave it out — engine treats
          // missing as empty.
        }
      }
      const report = runProjectLint({
        manifest,
        bodies,
        deadLinks,
        orphanedFiles
      });
      // If the project changed underneath us, drop this report.
      if (get().manifest?.root !== manifest.root) return;
      set({ lintReport: report });
    } catch (err) {
      logProjectError('refreshLint', err);
    }
  },

  // ============================ Frontmatter mutations ============================

  updateActiveTabFrontmatter(key: string, value: unknown) {
    const { tabs, activeTabIndex } = get();
    const tab = tabs[activeTabIndex];
    if (!tab) return;
    const next = { ...tab.frontmatter };
    next[key] = value;
    const nextTabs = tabs.slice();
    nextTabs[activeTabIndex] = { ...tab, frontmatter: next, dirty: true };
    set({ tabs: nextTabs });
  },

  removeActiveTabFrontmatter(key: string) {
    const { tabs, activeTabIndex } = get();
    const tab = tabs[activeTabIndex];
    if (!tab || !(key in tab.frontmatter)) return;
    const next = { ...tab.frontmatter };
    delete next[key];
    const nextTabs = tabs.slice();
    nextTabs[activeTabIndex] = { ...tab, frontmatter: next, dirty: true };
    set({ tabs: nextTabs });
  },

  renameActiveTabFrontmatterKey(oldKey: string, newKey: string) {
    const { tabs, activeTabIndex } = get();
    const tab = tabs[activeTabIndex];
    if (!tab) return;
    if (oldKey === newKey) return;
    if (!(oldKey in tab.frontmatter)) return;
    if (newKey in tab.frontmatter) return; // Conflict — silently no-op.
    // Rebuild the map preserving original key order, swapping oldKey→newKey
    // in place so the panel rows don't reorder unexpectedly.
    const next: FrontmatterMap = {};
    for (const [k, v] of Object.entries(tab.frontmatter)) {
      if (k === oldKey) next[newKey] = v;
      else next[k] = v;
    }
    const nextTabs = tabs.slice();
    nextTabs[activeTabIndex] = { ...tab, frontmatter: next, dirty: true };
    set({ tabs: nextTabs });
  }
}));

// ============================ Selectors ============================
//
// Stable selectors for components that only need derived state. Using
// these keeps re-renders tight — a tab body change shouldn't re-render
// the sidebar, etc.

export const selectActiveTab = (s: State): Tab | null => {
  if (s.activeTabIndex < 0) return null;
  return s.tabs[s.activeTabIndex] ?? null;
};

export const selectActivePath = (s: State): string | null =>
  selectActiveTab(s)?.path ?? null;

// ============================ Error logging ============================

export function logProjectError(label: string, err: unknown) {
  console.error(`[skrive project] ${label}`, err);
}
