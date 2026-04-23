// The project store — single source of truth for the currently open project,
// the set of open tabs, the active tab, and the session's layout state. Every
// file operation and layout change flows through the methods on `project`.
//
// Shape is tab-based per the A2 decision. Each tab owns its own layout mode
// and split-divider position so that switching files restores the view the
// user last had on that specific file.
//
// Pattern note: the methods are defined as standalone helper functions and
// then attached to the `project` object. This lets methods freely call each
// other without `this` binding or circular reference issues.

import { invoke } from "@tauri-apps/api/core";
import { preferences } from "$lib/stores/preferences.svelte";
import { markRecentSelfWrite } from "$lib/persistence/autosave";
import { computeLineDiff } from "$lib/diff/line-diff";
import type {
  Backlink,
  CheckpointVersion,
  DiffSide,
  DiffState,
  FileContent,
  GitVersion,
  HistoryEntry,
  HistoryMode,
  LayoutMode,
  PendingSelection,
  ProjectManifest,
  ProjectSchema,
  RenameReport,
  Tab,
} from "$lib/types";

// Module-level reactive state. Svelte 5 tracks reads through the proxy so
// any component that touches `project.*` subscribes to exactly the fields
// it reads and re-renders when those fields change.
let manifest = $state<ProjectManifest | null>(null);
let tabs = $state<Tab[]>([]);
let activeTabIndex = $state(-1);

// Sidebar visibility and width live at the project level, not per tab —
// toggling it affects the whole workspace. Width is driven by the
// drag-to-resize handle on the sidebar's right edge and persisted through
// ProjectUiState, so each project remembers its own width.
let sidebarVisible = $state(true);
let sidebarWidth = $state(260);

// Clamp bounds for the drag-to-resize handle. Min keeps the filename
// column readable; max keeps the sidebar from eating the editor. Exported
// so the handle can advertise them to assistive tech via aria-valuemin
// / aria-valuemax.
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 260;

// Frontmatter panel open/closed state. *Session only* — deliberately not
// persisted in ProjectUiState because the panel is a transient tool, not
// a layout preference. Every session starts with it closed; the user
// opens it as needed via ⌘⇧F or the header indicator.
let frontmatterPanelOpen = $state(false);

// Backlinks panel. Same session-only ethos as frontmatter and
// personal-dictionary: a floating tool anchored to the header's top-right
// zone, opened via `⌘⇧B` or the BL indicator. `backlinksOfActive` holds
// the most recent result for the active tab so both the indicator count
// and the panel render the same thing without two round-trips. Refreshed
// by +page.svelte on tab changes and watcher events — this store doesn't
// listen to filesystem activity itself.
let backlinksPanelOpen = $state(false);
let backlinksOfActive = $state<Backlink[]>([]);

// Version-history panel. Same session-only pattern as backlinks — a
// floating tool anchored to the header's top-right zone, opened via
// `⌘⇧H` or the HI indicator. `historyMode` is fetched once per project
// at `openProject` and dictates which backend drives the list
// (`get_git_history` or `get_checkpoint_history`). `historyOfActive`
// is the unified `HistoryEntry` shape both backends feed, newest-first.
// `historyPairBaseId` tracks the first-click anchor for the design
// memo's shift-click pair-compare flow — set on single-click, consumed
// on shift-click, cleared when the panel closes or the active tab
// changes.
let historyMode = $state<HistoryMode | null>(null);
let historyPanelOpen = $state(false);
let historyOfActive = $state<HistoryEntry[]>([]);
let historyPairBaseId = $state<string | null>(null);

// Rename-with-references modal. `renameModalPath` is the project-relative
// path being renamed (or null when the modal is closed). Both the F2
// shortcut and the sidebar "Rename…" context-menu item flow through
// `openRenameModal` so the modal has a single point of entry.
let renameModalPath = $state<string | null>(null);

// Monotonically-increasing counter that the editor surface watches to
// trigger a brief visual pulse whenever the system rewrites the body
// out from under the user (e.g. autosave's frontmatter auto-extract).
// The counter value is meaningless beyond "did it change since last time
// I looked"; consumers compare against their own remembered value.
let editorPulseSignal = $state(0);

const DEFAULT_LAYOUT_MODE: LayoutMode = "raw";
const DEFAULT_SPLIT_RATIO = 0.5;

// =========================== Helper implementations ===========================

async function openProjectImpl(path: string): Promise<void> {
  const next = await invoke<ProjectManifest>("open_project", { path });
  manifest = next;
  tabs = [];
  activeTabIndex = -1;
  // Reset the history surface on every open: the new project may be
  // in a different mode, and carrying over the previous project's
  // entries would show stale rows until the next refresh lands.
  historyOfActive = [];
  historyPairBaseId = null;
  historyPanelOpen = false;
  await fetchHistoryModeImpl();
  // Bump the recent-projects LRU so EmptyState + the project menu pick
  // up this open. `next.root` is the canonicalized path from Rust; the
  // project name is its last path segment.
  const name = extractProjectName(next.root);
  preferences.pushRecentProject(next.root, name);
}

function extractProjectName(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

async function openTabImpl(path: string): Promise<void> {
  // If already open, switch to it. Opening the same file twice should never
  // create duplicate tabs.
  const existing = tabs.findIndex((t) => t.path === path);
  if (existing !== -1) {
    activeTabIndex = existing;
    bumpRecentFile(path);
    return;
  }

  const content = await invoke<FileContent>("read_file", { path });
  tabs.push({
    path,
    content,
    dirty: false,
    layoutMode: DEFAULT_LAYOUT_MODE,
    splitDividerRatio: DEFAULT_SPLIT_RATIO,
    pendingSelection: null,
    diff: null,
  });
  activeTabIndex = tabs.length - 1;
  bumpRecentFile(path);
}

/**
 * Open a tab (switching to it if already open) and request that the
 * editor position its selection at the given line/column on mount.
 * Used by the search modal when a result is clicked.
 */
async function openTabAtLineImpl(
  path: string,
  line: number,
  column: number,
  length: number,
): Promise<void> {
  await openTabImpl(path);
  const tab = tabs[activeTabIndex];
  if (!tab) return;
  tab.pendingSelection = nextPendingSelection(line, column, length);
}

// Monotonic counter so repeated jumps produce distinct nonces even if
// two clicks land in the same millisecond.
let pendingSelectionCounter = 0;
function nextPendingSelection(
  line: number,
  column: number,
  length: number,
): PendingSelection {
  pendingSelectionCounter += 1;
  return { line, column, length, nonce: pendingSelectionCounter };
}

// Keep the cross-project recent-files LRU in sync with tab opens. Split
// out so both the "already open, switching to it" and "opened fresh"
// branches stay one-liners.
function bumpRecentFile(path: string): void {
  const root = manifest?.root;
  if (!root) return;
  preferences.pushRecentFile(root, path);
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
 * Cycle the active tab by `direction` (+1 for next, -1 for previous),
 * wrapping at the ends. No-op when no tabs are open — the binding in
 * +page.svelte still fires but there is nothing to switch to.
 */
function cycleActiveTabImpl(direction: 1 | -1): void {
  if (tabs.length === 0) return;
  const count = tabs.length;
  activeTabIndex = ((activeTabIndex + direction) % count + count) % count;
}

/**
 * Called by the editor's onChange when the user types. Updates the active
 * tab's body in place and flags it dirty. The disk write is driven by the
 * auto-save effect in +page.svelte, not here.
 */
function updateActiveTabContentImpl(body: string): void {
  if (activeTabIndex < 0) return;
  const tab = tabs[activeTabIndex];
  if (!tab) return;
  tab.content.body = body;
  tab.dirty = true;
}

/**
 * Mark a tab clean after its contents have been successfully written to disk.
 * Called by the auto-save driver.
 */
function markTabSavedImpl(path: string): void {
  const tab = tabs.find((t) => t.path === path);
  if (tab) tab.dirty = false;
}

/**
 * Replace the body of the tab at `path` with fresh content from disk.
 * Used when the watcher reports a file changed on disk and the user agrees
 * to (or implicitly accepts) a reload.
 */
async function reloadTabImpl(path: string): Promise<void> {
  const tab = tabs.find((t) => t.path === path);
  if (!tab) return;
  const fresh = await invoke<FileContent>("read_file", { path });
  tab.content = fresh;
  tab.dirty = false;
}

/**
 * Set the active tab's layout mode. When the tab is in diff mode, the
 * three editor-mode buttons in the header behave as follows:
 *   - `raw` / `preview` → stay in diff, switching between `diff-raw`
 *     and `diff-preview` so the user can flip representations without
 *     losing the diff they came to read. The UI surfaces this as two
 *     live buttons; `split` is rendered but disabled.
 *   - `split` → no-op (mutex rule from the UI memo). The header
 *     prevents the click from reaching us, but the guard here makes
 *     the store safe to call from any entry point.
 * Outside diff mode, the call is a simple field write.
 */
function setLayoutModeImpl(mode: LayoutMode): void {
  if (activeTabIndex < 0) return;
  const tab = tabs[activeTabIndex];
  if (!tab) return;

  if (tab.diff) {
    if (mode === "raw") {
      tab.layoutMode = "diff-raw";
      return;
    }
    if (mode === "preview") {
      tab.layoutMode = "diff-preview";
      return;
    }
    // `split` + any diff variant while already in diff: ignore.
    return;
  }

  // Outside diff mode, a request to enter diff-* directly is a
  // mis-routed caller — diff entry flows through `openDiffForEntry`
  // so the before/after state is populated. Silently normalize to
  // the underlying editor mode.
  if (mode === "diff-raw") {
    tab.layoutMode = "raw";
    return;
  }
  if (mode === "diff-preview") {
    tab.layoutMode = "preview";
    return;
  }

  tab.layoutMode = mode;
}

function setSplitDividerRatioImpl(ratio: number): void {
  if (activeTabIndex < 0) return;
  const tab = tabs[activeTabIndex];
  if (!tab) return;
  // Clamp so neither pane collapses to nothing — 15%/85% matches the common
  // editor-pane minimums and leaves room for the divider hit area.
  tab.splitDividerRatio = Math.max(0.15, Math.min(0.85, ratio));
}

function setSidebarVisibleImpl(visible: boolean): void {
  sidebarVisible = visible;
}

function toggleSidebarImpl(): void {
  sidebarVisible = !sidebarVisible;
}

function setSidebarWidthImpl(width: number): void {
  const clamped = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)),
  );
  sidebarWidth = clamped;
}

// =========================== Frontmatter actions ===========================

function openFrontmatterPanelImpl(): void {
  frontmatterPanelOpen = true;
}

function closeFrontmatterPanelImpl(): void {
  frontmatterPanelOpen = false;
}

function toggleFrontmatterPanelImpl(): void {
  frontmatterPanelOpen = !frontmatterPanelOpen;
}

// =========================== Backlinks actions ===========================

function openBacklinksPanelImpl(): void {
  backlinksPanelOpen = true;
}

function closeBacklinksPanelImpl(): void {
  backlinksPanelOpen = false;
}

function toggleBacklinksPanelImpl(): void {
  backlinksPanelOpen = !backlinksPanelOpen;
}

// =========================== History actions ===========================

function openHistoryPanelImpl(): void {
  historyPanelOpen = true;
}

function closeHistoryPanelImpl(): void {
  historyPanelOpen = false;
  // Closing clears the pair-compare anchor: the next open starts with
  // a clean slate, matching the "ephemeral tool" ethos of these panels.
  historyPairBaseId = null;
}

function toggleHistoryPanelImpl(): void {
  if (historyPanelOpen) {
    closeHistoryPanelImpl();
  } else {
    openHistoryPanelImpl();
  }
}

/**
 * Fetch `get_history_mode` and cache it on the store. Called once per
 * project by `openProject`. `null` here means "no project open" — the
 * header indicator hides itself when mode is unknown rather than
 * assuming a default.
 */
async function fetchHistoryModeImpl(): Promise<void> {
  if (!manifest) {
    historyMode = null;
    return;
  }
  try {
    historyMode = await invoke<HistoryMode>("get_history_mode");
  } catch (err) {
    console.warn("Failed to fetch history mode:", err);
    historyMode = null;
  }
}

/**
 * Re-query the history backend for the currently active tab and
 * update `historyOfActive`. Routes through `get_git_history` in
 * git-mode projects, `get_checkpoint_history` in checkpoint-mode,
 * and no-ops when mode is unknown or no tab is active. Same
 * stale-result guard as `refreshBacklinksForActive` — if the user
 * tab-switched mid-flight, drop the response.
 */
async function refreshHistoryForActiveImpl(): Promise<void> {
  const tab = tabs[activeTabIndex];
  if (!tab || !historyMode) {
    historyOfActive = [];
    return;
  }
  try {
    const entries = await fetchHistoryEntries(historyMode, tab.path);
    const current = tabs[activeTabIndex];
    if (current?.path !== tab.path) return;
    historyOfActive = entries;
  } catch (err) {
    console.warn("Failed to refresh history:", err);
    historyOfActive = [];
  }
}

async function fetchHistoryEntries(
  mode: HistoryMode,
  path: string,
): Promise<HistoryEntry[]> {
  if (mode === "git") {
    const rows = await invoke<GitVersion[]>("get_git_history", { path });
    return rows.map((row) => ({ source: "git" as const, ...row }));
  }
  const rows = await invoke<CheckpointVersion[]>("get_checkpoint_history", {
    path,
  });
  return rows.map((row) => ({ source: "checkpoint" as const, ...row }));
}

/**
 * Entry point from the history panel. Single-click passes
 * `(entry, null)` and diffs the entry against the active tab's
 * current content; shift-click passes `(entry, baseline)` and
 * pair-diffs two historical entries. The older of the two always
 * lands on the "before" pane regardless of click order — timestamp,
 * not gesture, decides left vs right.
 *
 * Silently no-ops when no tab is active, when the tab is in `split`
 * (the mutex rule from the UI memo), or when the entry belongs to
 * the wrong mode for the current project. Content fetches are
 * parallel so a slow git blob doesn't serialize behind a checkpoint.
 */
async function openDiffForEntryImpl(
  entry: HistoryEntry,
  baseline: HistoryEntry | null,
): Promise<void> {
  const tabIndex = activeTabIndex;
  if (tabIndex < 0) return;
  const tab = tabs[tabIndex];
  if (!tab) return;
  if (tab.layoutMode === "split") return;

  // Capture the pre-diff mode so close/Escape can undo the
  // transition cleanly. Diff variants coerce to raw — the restore
  // target is always an editor mode, never a diff mode.
  const restoreMode: "raw" | "preview" =
    tab.layoutMode === "preview" ? "preview" : "raw";
  const nextMode: LayoutMode =
    restoreMode === "preview" ? "diff-preview" : "diff-raw";

  try {
    const beforeEntry = baseline ?? entry;
    const afterEntry: HistoryEntry | null = baseline ? entry : null;
    // Order by timestamp so the older version always shows on the
    // left ("before"), matching the UI memo's pane convention.
    const [first, second] = await Promise.all([
      resolveDiffSide(tab.path, beforeEntry),
      afterEntry
        ? resolveDiffSide(tab.path, afterEntry)
        : resolveCurrentSide(tab),
    ]);
    const [left, right] =
      first.timestampMs <= second.timestampMs
        ? [first, second]
        : [second, first];

    // Diff the two sides once, up-front, so the renderer doesn't
    // re-run the algorithm on every frame. Rows are a flat array of
    // `{kind, before, after}` triples; see `diff/line-diff.ts`.
    const rows = await computeLineDiff(left.content, right.content);

    // Re-check the active tab in case it changed mid-fetch — dropping
    // the result is safer than flipping the wrong tab into diff mode.
    const current = tabs[activeTabIndex];
    if (!current || current.path !== tab.path) return;

    current.diff = {
      before: left,
      after: right,
      dividerRatio: 0.5,
      restoreMode,
      rows,
    };
    current.layoutMode = nextMode;
    historyPairBaseId = null;
    historyPanelOpen = false;
  } catch (err) {
    console.warn("Failed to load diff content:", err);
  }
}

async function resolveDiffSide(
  path: string,
  entry: HistoryEntry,
): Promise<DiffSide> {
  if (entry.source === "git") {
    const content = await invoke<string>("read_git_version", {
      path,
      sha: entry.sha,
    });
    return {
      content,
      timestampMs: entry.timestampMs,
      label: entry.subject || entry.shortSha,
      source: "git",
    };
  }
  const content = await invoke<string>("read_checkpoint_version", {
    path,
    id: entry.id,
  });
  const fallback = entry.kind === "manual" ? "Pinned" : "Autosave";
  return {
    content,
    timestampMs: entry.timestampMs,
    label: entry.name ?? fallback,
    source: "checkpoint",
  };
}

function resolveCurrentSide(tab: Tab): DiffSide {
  return {
    content: composeTabContent(tab),
    timestampMs: Date.now(),
    label: "Current",
    source: "current",
  };
}

// Compose the same frontmatter-plus-body string the Rust `write` path
// emits, so the "current" side of a diff matches what's on disk (or
// what would hit disk on the next save). Mirrors
// `src-tauri/src/project.rs::compose_file`.
function composeTabContent(tab: Tab): string {
  const fm = tab.content.frontmatter;
  const keys = Object.keys(fm);
  if (keys.length === 0) return tab.content.body;
  // We defer actual YAML serialization to the Rust side on save; for
  // the diff view's "current" side, serializing to the same bytes on
  // disk would need another IPC call. For now, the body alone is
  // close enough — the user's edits live in the body, not the
  // frontmatter map. Diff renderers that want frontmatter too will
  // get it from a future `compose_file` command.
  return tab.content.body;
}

function exitDiffModeImpl(): void {
  if (activeTabIndex < 0) return;
  const tab = tabs[activeTabIndex];
  if (!tab || !tab.diff) return;
  tab.layoutMode = tab.diff.restoreMode;
  tab.diff = null;
}

function setDiffDividerRatioImpl(ratio: number): void {
  if (activeTabIndex < 0) return;
  const tab = tabs[activeTabIndex];
  if (!tab?.diff) return;
  // Same clamp range as the editor split so the divider hit-area
  // never collapses flush against a pane edge.
  tab.diff.dividerRatio = Math.max(0.15, Math.min(0.85, ratio));
}

function setHistoryPairBaseIdImpl(id: string | null): void {
  historyPairBaseId = id;
}

/**
 * Whether the active tab can open a new diff right now. The history
 * panel reads this to gate its row clicks: a tab in `split` mode is
 * mutually exclusive with diff's two-pane surface, so we show a
 * "switch mode first" tooltip rather than silently ignoring clicks.
 */
function canEnterDiffForActiveImpl(): boolean {
  const tab = tabs[activeTabIndex];
  if (!tab) return false;
  return tab.layoutMode !== "split";
}

/**
 * Re-query `get_backlinks` for the currently active tab and update the
 * shared `backlinksOfActive` state. No-ops when no tab is active so the
 * header badge falls back to the prior result. Safe to call on rapid
 * tab switches — the command is cheap relative to typical tab-change
 * cadence and the last call wins.
 */
// =========================== Rename modal actions ===========================

function openRenameModalImpl(path: string): void {
  renameModalPath = path;
}

function closeRenameModalImpl(): void {
  renameModalPath = null;
}

/**
 * Commit a rename via the Rust `rename_with_references` command, then
 * reconcile the frontend state with what changed on disk:
 *
 * 1. Pre-stamp the old and new paths as recent self-writes so the
 *    watcher's Remove/Create echo events don't prompt the user.
 * 2. Invoke the Rust command. Returns the list of files it rewrote.
 * 3. Stamp every rewritten file's path too (their Modify events would
 *    otherwise race the tab reloads below).
 * 4. Swap any tab whose path is `oldPath` over to `newPath` — identity
 *    changes, dirty state is preserved because the file's *content*
 *    at the new path is the same content it had at the old path (the
 *    self-reference rewrites aside, which are applied to disk and need
 *    a reload for the open tab).
 * 5. For every rewritten path with an open tab:
 *    - Clean tabs silently reload so the updated references appear.
 *    - Dirty tabs are left as-is with a warning; the buffer already
 *      has the user's unsaved edits and we don't want to overwrite
 *      them silently. The user can review and save or discard.
 * 6. Refresh the manifest so the sidebar reflects the new path.
 *
 * Returns the report so callers (the modal's onCommit) can show a
 * summary toast.
 */
async function renameFileImpl(
  oldPath: string,
  newPath: string,
): Promise<{ report: RenameReport; dirtyConflicts: string[] }> {
  // Pre-stamp the two guaranteed paths. The filesystem watcher is the
  // race here — on macOS FSEvents a rename typically fires Remove on
  // old + Create on new within milliseconds of `fs::rename`.
  markRecentSelfWrite(oldPath);
  markRecentSelfWrite(newPath);

  const report = await invoke<RenameReport>("rename_with_references", {
    oldPath,
    newPath,
  });

  // Stamp the rewritten paths too. Doing this right after the command
  // returns keeps us inside the 1500ms self-write window for Modify
  // events that arrive later.
  for (const p of report.filesWritten) markRecentSelfWrite(p);

  // Swap tab identity for any tab pointing at the old path.
  for (const tab of tabs) {
    if (tab.path === oldPath) {
      tab.path = newPath;
    }
  }

  const dirtyConflicts: string[] = [];
  for (const writtenPath of report.filesWritten) {
    const tab = tabs.find((t) => t.path === writtenPath);
    if (!tab) continue;
    if (tab.dirty) {
      dirtyConflicts.push(writtenPath);
      continue;
    }
    try {
      await reloadTabImpl(writtenPath);
    } catch (err) {
      console.warn(`Failed to reload tab after rename: ${writtenPath}`, err);
    }
  }

  try {
    await refreshManifestImpl();
  } catch (err) {
    console.warn("Failed to refresh manifest after rename:", err);
  }

  return { report, dirtyConflicts };
}

async function refreshBacklinksForActiveImpl(): Promise<void> {
  const tab = tabs[activeTabIndex];
  if (!tab) {
    backlinksOfActive = [];
    return;
  }
  try {
    const result = await invoke<Backlink[]>("get_backlinks", {
      path: tab.path,
    });
    // Guard against a stale result — if the user tab-switched mid-flight,
    // drop the response rather than overwrite a newer fetch.
    const current = tabs[activeTabIndex];
    if (current?.path !== tab.path) return;
    backlinksOfActive = result;
  } catch (err) {
    console.warn("Failed to refresh backlinks:", err);
    backlinksOfActive = [];
  }
}

/**
 * Bump `editorPulseSignal` so any subscriber (currently `SplitView`)
 * runs a brief visual flash on the editor surface. Call this whenever
 * the system rewrites the active tab's body out from under the user
 * — the pulse is the breadcrumb that tells them "we touched this".
 */
function signalEditorPulseImpl(): void {
  editorPulseSignal = editorPulseSignal + 1;
}

/**
 * Set the value of a frontmatter field on the active tab, creating it if
 * it doesn't exist. Called from the panel on every value commit. Mutates
 * in place so the autosave path picks up the change by reference.
 */
function updateActiveTabFrontmatterImpl(key: string, value: unknown): void {
  if (activeTabIndex < 0) return;
  const tab = tabs[activeTabIndex];
  if (!tab) return;
  tab.content.frontmatter[key] = value;
  tab.dirty = true;
}

/**
 * Remove a frontmatter field from the active tab. No-op if the key is
 * absent. The × button and empty-key-on-blur both route through here.
 */
function removeActiveTabFrontmatterImpl(key: string): void {
  if (activeTabIndex < 0) return;
  const tab = tabs[activeTabIndex];
  if (!tab) return;
  if (!(key in tab.content.frontmatter)) return;
  delete tab.content.frontmatter[key];
  tab.dirty = true;
}

/**
 * Rename a frontmatter key while preserving its value. Silently no-ops
 * when the rename would overwrite an existing different key, which is
 * the "rename conflict → silently revert" rule from the plan. The panel
 * re-reads the map after calling this, so a no-op naturally shows the
 * old key again in the UI.
 */
function renameActiveTabFrontmatterKeyImpl(
  oldKey: string,
  newKey: string,
): void {
  if (activeTabIndex < 0) return;
  const tab = tabs[activeTabIndex];
  if (!tab) return;
  if (oldKey === newKey) return;
  if (!(oldKey in tab.content.frontmatter)) return;
  if (newKey in tab.content.frontmatter) return; // conflict → revert
  const value = tab.content.frontmatter[oldKey];
  delete tab.content.frontmatter[oldKey];
  tab.content.frontmatter[newKey] = value;
  tab.dirty = true;
}

function closeProjectImpl(): void {
  manifest = null;
  tabs = [];
  activeTabIndex = -1;
  historyMode = null;
  historyOfActive = [];
  historyPairBaseId = null;
  historyPanelOpen = false;
}

/**
 * Re-scan the current project. Used after creating a new file so the manifest
 * reflects it immediately — once the watcher drives manifest refreshes, this
 * will fire from watcher events instead of explicit calls.
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

/**
 * Create a new subdirectory inside the currently open project. The sidebar
 * picks it up after manifest refresh; empty dirs only show as a group once
 * a file lives inside them, which matches the sidebar's directory-grouping
 * model.
 */
async function createDirectoryImpl(relativePath: string): Promise<void> {
  await invoke<void>("create_subdirectory", { path: relativePath });
  await refreshManifestImpl();
}

/**
 * Move a file in the project to the OS trash, close any tab that was
 * editing it, and refresh the manifest. Dirty edits are dropped silently
 * — OS trash is the safety net per the pre-dogfood plan's decision 4.
 */
async function deleteFileImpl(relativePath: string): Promise<void> {
  await invoke<void>("delete_path", { path: relativePath });
  const idx = tabs.findIndex((t) => t.path === relativePath);
  if (idx !== -1) closeTabImpl(idx);
  await refreshManifestImpl();
}

/**
 * Move a directory (and its contents) to the OS trash. Closes every tab
 * whose file lived under the directory; same dirty-drop policy as
 * `deleteFile`.
 */
async function deleteDirectoryImpl(relativePath: string): Promise<void> {
  await invoke<void>("delete_path", { path: relativePath });
  const prefix = relativePath.endsWith("/") ? relativePath : relativePath + "/";
  // Walk from the end so splice indexes stay valid during iteration.
  for (let i = tabs.length - 1; i >= 0; i--) {
    const path = tabs[i]?.path;
    if (path && (path === relativePath || path.startsWith(prefix))) {
      closeTabImpl(i);
    }
  }
  await refreshManifestImpl();
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
  /**
   * Project-wide frontmatter schema, inferred at `open_project` time.
   * Returns `null` when no project is open. Read by the Phase 2.3
   * frontmatter panel and autocomplete layer.
   */
  get schema(): ProjectSchema | null {
    return manifest?.schema ?? null;
  },
  get sidebarVisible() {
    return sidebarVisible;
  },
  get sidebarWidth() {
    return sidebarWidth;
  },
  get frontmatterPanelOpen() {
    return frontmatterPanelOpen;
  },
  get backlinksPanelOpen() {
    return backlinksPanelOpen;
  },
  get backlinksOfActive(): Backlink[] {
    return backlinksOfActive;
  },
  get historyMode(): HistoryMode | null {
    return historyMode;
  },
  get historyPanelOpen() {
    return historyPanelOpen;
  },
  get historyOfActive(): HistoryEntry[] {
    return historyOfActive;
  },
  get historyPairBaseId(): string | null {
    return historyPairBaseId;
  },
  get renameModalPath(): string | null {
    return renameModalPath;
  },
  get editorPulseSignal() {
    return editorPulseSignal;
  },

  openProject: openProjectImpl,
  openTab: openTabImpl,
  closeTab: closeTabImpl,
  switchTab: switchTabImpl,
  cycleActiveTab: cycleActiveTabImpl,
  updateActiveTabContent: updateActiveTabContentImpl,
  markTabSaved: markTabSavedImpl,
  reloadTab: reloadTabImpl,
  setLayoutMode: setLayoutModeImpl,
  setSplitDividerRatio: setSplitDividerRatioImpl,
  setSidebarVisible: setSidebarVisibleImpl,
  toggleSidebar: toggleSidebarImpl,
  setSidebarWidth: setSidebarWidthImpl,
  openFrontmatterPanel: openFrontmatterPanelImpl,
  closeFrontmatterPanel: closeFrontmatterPanelImpl,
  toggleFrontmatterPanel: toggleFrontmatterPanelImpl,
  openBacklinksPanel: openBacklinksPanelImpl,
  closeBacklinksPanel: closeBacklinksPanelImpl,
  toggleBacklinksPanel: toggleBacklinksPanelImpl,
  refreshBacklinksForActive: refreshBacklinksForActiveImpl,
  openHistoryPanel: openHistoryPanelImpl,
  closeHistoryPanel: closeHistoryPanelImpl,
  toggleHistoryPanel: toggleHistoryPanelImpl,
  refreshHistoryForActive: refreshHistoryForActiveImpl,
  fetchHistoryMode: fetchHistoryModeImpl,
  openDiffForEntry: openDiffForEntryImpl,
  exitDiffMode: exitDiffModeImpl,
  setDiffDividerRatio: setDiffDividerRatioImpl,
  setHistoryPairBaseId: setHistoryPairBaseIdImpl,
  canEnterDiffForActive: canEnterDiffForActiveImpl,
  openRenameModal: openRenameModalImpl,
  closeRenameModal: closeRenameModalImpl,
  renameFile: renameFileImpl,
  signalEditorPulse: signalEditorPulseImpl,
  updateActiveTabFrontmatter: updateActiveTabFrontmatterImpl,
  removeActiveTabFrontmatter: removeActiveTabFrontmatterImpl,
  renameActiveTabFrontmatterKey: renameActiveTabFrontmatterKeyImpl,
  closeProject: closeProjectImpl,
  refreshManifest: refreshManifestImpl,
  createProject: createProjectImpl,
  createFile: createFileImpl,
  createDirectory: createDirectoryImpl,
  deleteFile: deleteFileImpl,
  deleteDirectory: deleteDirectoryImpl,
  openTabAtLine: openTabAtLineImpl,
};
