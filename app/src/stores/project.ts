// The project store — zustand, single source of truth for the open
// project, the open tabs, the active tab, and sidebar visibility/width.
//
// Phase 4 swaps the single-active-file model from Phase 3 for the tabs
// layer. Each tab carries its own layoutMode + splitDividerRatio so that
// switching files restores the view the user last had on that file.
//
// Phase 9 wires per-project persistence: the tab set, cursor/scroll
// state, layout mode, and sidebar visibility/width are reloaded from
// `{userData}/projects/{hash}.json` on open and written back via three
// tiers — immediate (open/close/reorder, layout, sidebar visibility),
// debounced 1s (scroll, split-divider drag, sidebar width drag), and
// blur/quit (cursor position).

import { create } from 'zustand';
import {
  defaultProjectUiState,
  type FileEntry,
  type FrontmatterMap,
  type HistoryEntry,
  type HistoryMode,
  type LineDiffRow,
  type ProjectChange,
  type ProjectLintReport,
  type ProjectManifest,
  type ProjectUiState,
  type TabState
} from '@skrive/shared';
import type { LayoutMode } from '../components/editor/SplitView';
import { computeLineDiff } from '../lib/diff/line-diff';
import {
  mightHaveLeadingFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
  stampAutoFields
} from '../lib/frontmatter';
import { runProjectLint } from '../lib/lint';
import type { LintWorkerResponse } from '../lib/lint/lint-worker-protocol';
import { notify } from '../lib/notify';
import { logDuration, now as perfNow } from '../lib/perf';
import { usePreferencesStore } from './preferences';

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 260;

const DEFAULT_LAYOUT_MODE: LayoutMode = 'split';
const DEFAULT_SPLIT_RATIO = 0.5;
const DEBOUNCED_SAVE_MS = 1000;

export type WorkspaceView = 'editor' | 'settings';

/** A one-shot "go to this position with this selection length" request
 *  applied by the editor on the next render. The nonce is what the
 *  Editor effect tracks — bumping it re-fires even when line/column
 *  repeat (jumping back to the same hit a second time still works). */
export type PendingSelection = {
  line: number;
  column: number;
  length: number;
  nonce: number;
};

/** One side of a side-by-side diff. `source` distinguishes git
 *  blobs, on-disk checkpoints, and the live working content; the
 *  `label` is what DiffView renders on the pane header. */
export type DiffSide = {
  content: string;
  timestampMs: number;
  label: string;
  source: 'git' | 'checkpoint' | 'current';
};

/** Active diff state on a tab. Diff lives at the tab level so
 *  switching tabs preserves it; closing the diff (Escape / X)
 *  restores `restoreMode` so the user lands back where they started.
 *  Not persisted — diff is an ephemeral overlay. */
export type TabDiffState = {
  before: DiffSide;
  after: DiffSide;
  rows: LineDiffRow[];
  dividerRatio: number;
  /** Editor mode the tab returns to on close. Diff entry from
   *  'preview' returns to 'preview'; anything else returns to 'raw'.
   *  Diff entry from 'split' is blocked at the panel layer. */
  restoreMode: 'raw' | 'preview';
  /** Sub-mode controlling DiffView's pane content. */
  diffMode: 'diff-raw' | 'diff-preview';
};

export type Tab = {
  path: string;
  /** Body without the leading frontmatter block. The editor reads/writes
   *  this; the full file is reassembled at save time. */
  body: string;
  /** Parsed YAML frontmatter for the file. Populated on openTab; mutated
   *  by the FrontmatterPanel; auto-stamped fields refreshed on save. */
  frontmatter: FrontmatterMap;
  dirty: boolean;
  /** SHA-256 of the file as last loaded or saved. Baseline for external-change
   *  detection — compared against the on-disk file before an auto-save so we
   *  don't silently clobber an edit made outside Skrive. Not persisted. */
  diskHash: string;
  /** Set when an auto-save found the file changed on disk. Auto-save then skips
   *  this tab (keeping it dirty) until the writer resolves it via Overwrite or
   *  an explicit ⌘S. Not persisted. */
  conflict: boolean;
  layoutMode: LayoutMode;
  splitDividerRatio: number;
  /** Cursor + scroll persisted in the per-project state (Phase 9).
   *  `cursorLine` is 1-indexed (CodeMirror line numbers); `cursorColumn`
   *  is 0-indexed UTF-16 within the line. */
  cursorLine: number;
  cursorColumn: number;
  scrollTop: number;
  /** Search / backlinks jump request. Editor consumes via nonce-tracked
   *  effect; cleared after apply. Not persisted. */
  pendingSelection: PendingSelection | null;
  /** Active history-driven diff overlay. When non-null, the workspace
   *  area renders DiffView in place of SplitView for this tab. */
  diff: TabDiffState | null;
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

  /** Path of the file currently being renamed, or null when no
   *  rename modal is open. Lives at the project level so the modal
   *  doesn't lose its target if the active tab changes mid-flight. */
  renameModalPath: string | null;

  /** Floating top-right history list (phase 10). One row per git
   *  commit or checkpoint touching the active tab. Mutually exclusive
   *  with backlinks + frontmatter. */
  historyPanelOpen: boolean;
  /** Project-level history backend, decided at project:open. Drives
   *  the panel's mode badge and gates the manual-checkpoint action. */
  historyMode: HistoryMode | null;
  /** History rows for the active tab. Refreshed on tab change + on
   *  watcher events that touch the tab's path. */
  historyOfActive: HistoryEntry[];
  /** The "baseline" entry for shift-click pair compares. Stashed by
   *  every single click; consumed by the next shift-click. */
  historyPairBaseId: string | null;

  /** What's filling the workspace area. `'editor'` is the normal
   *  SplitView; `'settings'` is the project-scoped Settings page,
   *  invoked via ⌘, (Phase 9). Resets to `'editor'` on every project
   *  open / close. */
  activeView: WorkspaceView;

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

  openTab(path: string, hydrate?: HydrateTab): Promise<void>;
  /** Open `path` (or focus the existing tab) and request a selection
   *  spanning `length` UTF-16 code units starting at (`line`, `column`).
   *  Used by the search modal and any "jump to here" surface. */
  openTabAtLine(
    path: string,
    line: number,
    column: number,
    length: number
  ): Promise<void>;
  closeTab(index: number): Promise<void>;
  switchTab(index: number): void;
  /** Cleared from the editor after the selection has been applied so a
   *  subsequent re-render with the same nonce doesn't re-apply. */
  clearPendingSelection(index: number): void;

  setTabBody(index: number, next: string): void;
  setTabLayoutMode(index: number, mode: LayoutMode): void;
  setTabSplitRatio(index: number, ratio: number): void;
  setTabCursor(index: number, line: number, column: number): void;
  setTabScrollTop(index: number, top: number): void;

  saveActiveTab(): Promise<void>;
  saveAllDirty(): Promise<void>;
  /** Overwrite the on-disk file with the editor's version, resolving an
   *  external-change conflict. Invoked from the Overwrite prompt. */
  forceSaveTab(path: string): Promise<void>;

  createFile(relPath: string): Promise<void>;
  createDirectory(relPath: string): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
  deleteDirectory(relPath: string): Promise<void>;

  setSidebarVisible(v: boolean): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;

  setActiveView(view: WorkspaceView): void;
  toggleSettings(): void;

  /** Flush any pending project-state debounce immediately. Used by
   *  the beforeunload handler and project close. Safe to call when no
   *  project is open. */
  persistProjectStateNow(): Promise<void>;

  setBacklinksPanelOpen(v: boolean): void;
  toggleBacklinksPanel(): void;

  setFrontmatterPanelOpen(v: boolean): void;
  toggleFrontmatterPanel(): void;
  closeFrontmatterPanel(): void;

  openRenameModal(path: string): void;
  closeRenameModal(): void;
  /** Commit a rename through linkGraph.renameWithReferences. Renames
   *  the file, rewrites every reference, and walks open tabs to point
   *  the renamed one at its new path. Refreshes the manifest from the
   *  watcher event afterwards. */
  commitRename(oldPath: string, newPath: string): Promise<void>;

  setHistoryPanelOpen(v: boolean): void;
  toggleHistoryPanel(): void;
  closeHistoryPanel(): void;
  setHistoryPairBaseId(id: string | null): void;
  /** Refresh history rows for the active tab. Called when the panel
   *  opens, when the active tab changes, and when the watcher reports
   *  a change to the active path. Best-effort. */
  refreshHistory(): Promise<void>;
  /** Render the diff overlay on the active tab. Single click passes
   *  `(entry, null)` — diff against current. Shift-click passes
   *  `(entry, baseline)` — pair-diff. Older side always lands on the
   *  "before" pane regardless of click order. */
  openDiffForEntry(
    entry: HistoryEntry,
    baseline: HistoryEntry | null
  ): Promise<void>;
  /** Close the diff overlay; restore the editor mode it replaced. */
  closeDiff(): void;
  setTabDiffMode(index: number, mode: 'diff-raw' | 'diff-preview'): void;
  setTabDiffDividerRatio(index: number, ratio: number): void;
  /** Pin the active tab's current contents as a manual checkpoint.
   *  No-op in git mode (the panel hides the action). */
  createManualCheckpoint(name: string): Promise<void>;

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

type HydrateTab = {
  cursorLine: number;
  cursorColumn: number;
  scrollTop: number;
  layoutMode: LayoutMode;
  splitDividerRatio: number;
  /** When true, openTab will not overwrite the layout/ratio with the
   *  defaults — it sets them from this object. Used during the
   *  per-project state restore on `openProject`. */
  applyOverrides: true;
};

function clampSidebarWidth(w: number): number {
  if (Number.isNaN(w)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w));
}

// ============================ Persistence pipeline ============================
//
// Three save tiers per A3:
//   - Immediate: tab open/close, layout-mode, sidebar visibility.
//   - Debounced 1s: scroll, split-divider drag, sidebar width drag.
//   - Blur/quit: cursor position (saves on tab switch, tab close,
//     project close, beforeunload).
//
// The renderer doesn't track "dirty" per tier; it just schedules a
// timer and any incoming save before the timer fires resets it. The
// flush action grabs whatever's currently in the store.

let debouncedSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastImmediateSave: Promise<void> = Promise.resolve();

// The file watcher fires on every change in the project tree — including the
// app's own debounced autosaves. Coalesce a burst of events into a single
// manifest+lint refresh, with the window set wider than the autosave cadence
// (SAVE_DEBOUNCE_MS in App.tsx, 500ms) so nothing re-lints while the writer is
// mid-keystroke. An external edit reflects ~one debounce window later, which is
// imperceptible for a writing app.
const WATCH_REFRESH_DEBOUNCE_MS = 750;
let watchRefreshTimer: ReturnType<typeof setTimeout> | null = null;

// refreshLint reads every project file and runs the cross-file engine — a few
// hundred ms on a large project. Single-flight it so coalesced or rapid triggers
// cannot stack overlapping passes that saturate the main thread; a request that
// arrives mid-pass schedules exactly one rerun when the current pass finishes.
let lintInFlight = false;
let lintRerunQueued = false;

// Closed-file body cache for lint. Open tabs always supply their live in-memory
// body; the bodies of *closed* files change only via the watcher, which hands us
// the exact path. So we read each closed file once, cache it, and re-read only
// the paths the watcher reports dirty — during editing no closed file changes,
// so the per-pass disk reads (the cost the AST memo didn't cover) drop to zero.
// Keyed by project-relative path; cleared on project switch since paths can
// collide across projects.
const closedBodyCache = new Map<string, string>();
const watchDirtyPaths = new Set<string>();

function resetLintReadCache(): void {
  closedBodyCache.clear();
  watchDirtyPaths.clear();
}

// The lint engine runs in a dedicated Worker (Stage 2.75) so a pass never
// blocks the typing thread — the engine is ~37ms on a large project with
// periodic GC spikes, and even debounced that micro-stutters the editor when
// it lands on the typing thread. The worker owns the file-body map across
// passes; the store posts inputs and applies the report it sends back. Its
// lifecycle mirrors the watcher/read-cache teardown: spawned on project open,
// torn down + reset on project switch and close. If worker construction ever
// fails, refreshLint falls back to running the (pure) engine on the main
// thread so lint still works, degraded.
let lintWorker: Worker | null = null;
// Monotonic request id, echoed by the worker. With single-flight there is only
// ever one outstanding request, so a result whose seq doesn't match the latest
// is a leftover from a torn-down worker and is dropped.
let lintSeq = 0;
// Project root + perf clock captured at post time, read when the result lands.
let lintRequestRoot: string | null = null;
let lintRequestStart = 0;
// Mirror of the body map the worker currently holds. Each pass ships only the
// diff against this (changed/new bodies + dropped paths), so a keystroke posts
// one entry rather than re-cloning the whole project across postMessage. Reset
// whenever the worker is replaced, since a fresh worker starts with no bodies.
let sentBodies = new Map<string, string>();

// The manifest the worker currently holds. The worker caches it across passes,
// so we ship the (heavy, ~95-entry) manifest only when its identity changes —
// during prose typing it doesn't, so we send `null` and skip the structured
// clone entirely. Identity is stable because refreshManifest only swaps in a new
// manifest object when its lint-relevant version actually changed (below).
let sentManifest: ProjectManifest | null = null;

// Last manifest version the store has applied, from project:getManifest. The
// main process bumps it only on lint/structure-relevant changes (file-set or
// frontmatter), never on content-only saves — so a watcher refresh during
// typing is a no-op here and never churns the manifest or the sidebar.
let lastManifestVersion = -1;

// Lint is driven directly off edits (debounced), decoupled from the watcher /
// manifest rescan path: typing schedules a pass that reads in-memory bodies, so
// findings refresh on a pause without waiting for autosave -> watcher. The
// debounce coalesces a typing burst (and any watcher echo of our own save) into
// a single off-thread pass; single-flight handles overlap.
const LINT_DEBOUNCE_MS = 500;
let lintDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleLint(): void {
  if (lintDebounceTimer) clearTimeout(lintDebounceTimer);
  lintDebounceTimer = setTimeout(() => {
    lintDebounceTimer = null;
    void useProjectStore.getState().refreshLint();
  }, LINT_DEBOUNCE_MS);
}

function spawnLintWorker(): void {
  terminateLintWorker();
  try {
    lintWorker = new Worker(
      new URL('../lib/lint/lint.worker.ts', import.meta.url),
      { type: 'module' }
    );
    lintWorker.onmessage = (event: MessageEvent<LintWorkerResponse>) => {
      handleLintResult(event.data);
    };
    lintWorker.onerror = (event) => {
      logProjectError('lint worker', event.message || event);
      // Unwedge the pipeline so the next watcher event can retrigger lint.
      lintInFlight = false;
      lintRerunQueued = false;
    };
  } catch (err) {
    logProjectError('spawn lint worker', err);
    lintWorker = null;
  }
}

function terminateLintWorker(): void {
  if (lintWorker) {
    lintWorker.terminate();
    lintWorker = null;
  }
}

function resetLintPipeline(): void {
  terminateLintWorker();
  if (lintDebounceTimer) {
    clearTimeout(lintDebounceTimer);
    lintDebounceTimer = null;
  }
  lintInFlight = false;
  lintRerunQueued = false;
  lintRequestRoot = null;
  sentBodies = new Map();
  sentManifest = null;
  lastManifestVersion = -1;
}

// Cheap structural equality on two finding sets. Findings arrive sorted +
// deduped from the engine, so a positional walk is sufficient. Used to suppress
// no-op lintReport updates: most editing passes re-derive the *same* findings,
// and pushing a new report each time re-renders every consumer (App's memo, the
// editor, the CM6 lint decorations) on the typing thread for nothing — which is
// the GC pressure that was spiking serializeDoc.
function lintFindingsEqual(
  a: ProjectLintReport | null,
  b: ProjectLintReport
): boolean {
  if (!a) return false;
  if (a.findings.length !== b.findings.length) return false;
  for (let i = 0; i < a.findings.length; i++) {
    const x = a.findings[i]!;
    const y = b.findings[i]!;
    if (
      x.rule !== y.rule ||
      x.path !== y.path ||
      x.line !== y.line ||
      x.column !== y.column ||
      x.message !== y.message ||
      x.severity !== y.severity
    ) {
      return false;
    }
  }
  return true;
}

// Worker → store. Applies the report (unless a project switch has obsoleted it)
// and releases the single-flight latch, draining any rerun queued mid-pass.
function handleLintResult(msg: LintWorkerResponse): void {
  if (msg.seq !== lintSeq) return;
  const store = useProjectStore.getState();
  if (store.manifest?.root === lintRequestRoot) {
    // Only publish when the findings actually changed — see lintFindingsEqual.
    if (!lintFindingsEqual(store.lintReport, msg.report)) {
      useProjectStore.setState({ lintReport: msg.report });
    }
    logDuration(
      `lint (${msg.report.findings.length} findings, worker ${msg.workerMs.toFixed(1)}ms)`,
      lintRequestStart
    );
  }
  lintInFlight = false;
  if (lintRerunQueued) {
    lintRerunQueued = false;
    void store.refreshLint();
  }
}

// Monotonic counter so each openTabAtLine call produces a fresh nonce.
// The Editor effect tracks this; identical line/column requests still
// re-fire because the nonce always advances.
let pendingSelectionCounter = 0;

function snapshotProjectState(state: State): ProjectUiState | null {
  if (!state.manifest) return null;
  const config = state.manifest.config;
  return {
    schemaVersion: 1,
    projectPath: state.manifest.root,
    projectName:
      config.project.name ??
      basename(state.manifest.root) ??
      state.manifest.root,
    lastOpenedMs: Date.now(),
    sidebar: {
      visible: state.sidebarVisible,
      width: state.sidebarWidth
    },
    tabs: state.tabs.map(
      (tab): TabState => ({
        path: tab.path,
        layoutMode: tab.layoutMode,
        cursor: { line: tab.cursorLine, column: tab.cursorColumn },
        scrollTop: tab.scrollTop,
        splitDividerRatio: tab.splitDividerRatio
      })
    ),
    activeTabIndex: state.activeTabIndex
  };
}

function basename(p: string): string | null {
  if (!p) return null;
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function scheduleImmediateSave(getState: () => State): void {
  const state = getState();
  if (!state.manifest) return;
  const snapshot = snapshotProjectState(state);
  if (!snapshot) return;
  const root = state.manifest.root;
  lastImmediateSave = (async () => {
    try {
      await window.skrive.persistence.saveProjectState(root, snapshot);
    } catch (err) {
      logProjectError('saveProjectState', err);
    }
  })();
}

function scheduleDebouncedSave(getState: () => State): void {
  if (debouncedSaveTimer) clearTimeout(debouncedSaveTimer);
  debouncedSaveTimer = setTimeout(() => {
    debouncedSaveTimer = null;
    scheduleImmediateSave(getState);
  }, DEBOUNCED_SAVE_MS);
}

// Coalesce watcher-driven manifest+lint refreshes. Each new file event resets
// the timer, so a run of autosaves (or any burst) collapses into one refresh
// once the tree settles.
function scheduleWatchRefresh(getState: () => State & Actions): void {
  if (watchRefreshTimer) clearTimeout(watchRefreshTimer);
  watchRefreshTimer = setTimeout(() => {
    watchRefreshTimer = null;
    void getState().refreshManifest();
  }, WATCH_REFRESH_DEBOUNCE_MS);
}

function cancelWatchRefresh(): void {
  if (watchRefreshTimer) {
    clearTimeout(watchRefreshTimer);
    watchRefreshTimer = null;
  }
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
/**
 * Build a DiffSide from a HistoryEntry. Fetches the historical content
 * via the appropriate IPC; the returned `label` is short (subject
 * line, manual pin name, or "Autosave") so the DiffView pane header
 * stays scannable.
 */
async function resolveDiffSide(
  relPath: string,
  entry: HistoryEntry
): Promise<DiffSide> {
  if (entry.source === 'git') {
    const content = await window.skrive.history.readGitBlobAt(
      relPath,
      entry.sha
    );
    return {
      content,
      timestampMs: entry.timestampMs,
      label: entry.subject || entry.shortSha,
      source: 'git'
    };
  }
  const content = await window.skrive.history.readCheckpointAt(
    relPath,
    entry.id
  );
  const fallback = entry.kind === 'manual' ? 'Pinned' : 'Autosave';
  return {
    content,
    timestampMs: entry.timestampMs,
    label: entry.name ?? fallback,
    source: 'checkpoint'
  };
}

/** "Current" side of the diff — the live, possibly-dirty body of the
 *  active tab, exactly the bytes a save would emit. We re-stamp
 *  frontmatter on the fly via buildSavePayload so the diff matches
 *  what the next save writes. */
function resolveCurrentSide(tab: Tab): DiffSide {
  const writable: Tab = { ...tab, frontmatter: { ...tab.frontmatter } };
  return {
    content: buildSavePayload(writable),
    timestampMs: Date.now(),
    label: 'Current',
    source: 'current'
  };
}

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
  const body = usePreferencesStore.getState().formatOnSave
    ? normalizeMarkdownSpacing(tab.body)
    : tab.body;
  return serializeFrontmatter(tab.frontmatter) + body;
}

/** Conservative "format on save": tidy whitespace without touching what
 *  renders. Whitespace-only lines are cleared (they're blank either way,
 *  and never Markdown hard breaks, which live as trailing spaces on
 *  *content* lines and are preserved here), and the file ends with
 *  exactly one trailing newline. Deliberately does not reflow, collapse
 *  blank runs, or restyle, so it can't change meaning or mangle code. */
function normalizeMarkdownSpacing(body: string): string {
  const cleared = body
    .split('\n')
    .map((line) => (/^[ \t]+$/.test(line) ? '' : line))
    .join('\n')
    .replace(/\n+$/, '');
  return cleared.length === 0 ? '' : `${cleared}\n`;
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
  historyPanelOpen: false,
  historyMode: null,
  historyOfActive: [],
  historyPairBaseId: null,
  renameModalPath: null,
  activeView: 'editor',
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
      // Flush any debounced project state from the previously open
      // project before tearing it down. closeProject already saves
      // dirty tabs, but if the user goes File → Open without quitting,
      // the previous project's project.json could lose a debounced
      // sidebar/scroll write otherwise.
      await get().persistProjectStateNow();

      const prev = get().unsubscribeWatch;
      if (prev) prev();
      await window.skrive.project.unwatch();
      cancelWatchRefresh();
      resetLintReadCache();
      resetLintPipeline();

      const manifest = await window.skrive.project.open(path);

      const unsubscribe = window.skrive.project.onChange((event) => {
        if (event.kind === 'ready') return;
        // Record which path changed so the next lint re-reads only that file
        // and serves the rest from the closed-body cache. (Dir events carry a
        // path too; tracking it is harmless — it just isn't a lintable file.)
        if ('path' in event) watchDirtyPaths.add(event.path);
        // Debounced: the app's own autosaves fire watcher events too, and an
        // undebounced full re-lint per event stacks passes on the main thread
        // and stutters typing. Coalesce to one refresh once edits settle.
        scheduleWatchRefresh(get);
      });
      await window.skrive.project.watch(manifest.root);

      // Phase 9: pull the persisted UI state for this project before
      // committing the manifest, so the initial render lands with the
      // saved sidebar geometry / tabs / cursor instead of flashing
      // defaults.
      const persisted = await window.skrive.persistence.loadProjectState(
        manifest.root
      );

      const sidebarState = persisted?.sidebar ?? {
        visible: true,
        width: SIDEBAR_DEFAULT_WIDTH
      };

      // Phase 10: pull the project's history mode (git vs checkpoint)
      // up-front so HI button + history panel pick it up on first
      // render. Best-effort — fall back to checkpoint if the IPC
      // hiccups; history listing degrades gracefully on either path.
      let historyMode: HistoryMode = 'checkpoint';
      try {
        historyMode = await window.skrive.history.getMode();
      } catch (err) {
        logProjectError('history:getMode', err);
      }

      set({
        manifest,
        tabs: [],
        activeTabIndex: -1,
        sidebarVisible: sidebarState.visible,
        sidebarWidth: clampSidebarWidth(sidebarState.width),
        activeView: 'editor',
        lintReport: null,
        historyMode,
        historyOfActive: [],
        historyPairBaseId: null,
        historyPanelOpen: false,
        unsubscribeWatch: unsubscribe,
        loading: false
      });

      // Re-open every tab the user had last time, in order. Each tab
      // hydrates with its persisted layout/cursor/scroll/ratio.
      if (persisted) {
        for (const t of persisted.tabs) {
          const exists = manifest.files.some((f) => f.path === t.path);
          if (!exists) continue;
          await get().openTab(t.path, {
            cursorLine: t.cursor.line,
            cursorColumn: t.cursor.column,
            scrollTop: t.scrollTop,
            layoutMode: t.layoutMode,
            splitDividerRatio: clampRatio(t.splitDividerRatio),
            applyOverrides: true
          });
        }
        const tabsAfter = get().tabs;
        const target = Math.min(
          Math.max(persisted.activeTabIndex, -1),
          tabsAfter.length - 1
        );
        if (target >= 0) set({ activeTabIndex: target });
      }

      // Recent-projects + last-opened bookkeeping. Survives writes
      // through the preferences store's debounce.
      const prefs = usePreferencesStore.getState();
      const projectName = manifest.config.project.name ?? basename(manifest.root) ?? manifest.root;
      prefs.recordRecentProject(manifest.root, projectName);
      prefs.setLastOpenedProject(manifest.root);

      // Surface .skrive.toml warnings once per open. Live reload is
      // a documented post-port follow-up; reopen the project to apply
      // edits and re-trigger validation.
      for (const warning of manifest.warnings) {
        notify.warn(warning);
      }
      // Stand up the off-thread engine before the first pass.
      spawnLintWorker();
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
    cancelWatchRefresh();
    resetLintReadCache();
    resetLintPipeline();
    // Flush dirty tabs + persist project UI state before clearing.
    await get().saveAllDirty();
    await get().persistProjectStateNow();
    usePreferencesStore.getState().setLastOpenedProject(null);
    set({
      manifest: null,
      tabs: [],
      activeTabIndex: -1,
      activeView: 'editor',
      lintReport: null,
      historyMode: null,
      historyOfActive: [],
      historyPairBaseId: null,
      historyPanelOpen: false,
      unsubscribeWatch: null
    });
  },

  async refreshManifest() {
    const manifest = get().manifest;
    if (!manifest) return;
    // Cheap O(1) read of the main process's incrementally-maintained manifest —
    // no full rescan. `version` bumps only on lint/structure-relevant changes
    // (file-set or frontmatter), so a content-only save (the common watcher
    // event while typing) returns the same version and we skip the swap-in
    // entirely: no new manifest object, no sidebar re-render, no manifest
    // re-ship to the worker.
    const result = await window.skrive.project.getManifest();
    // Always re-lint — a content change to a closed file bumps no version but
    // can still move cross-file findings; the debounce coalesces this with any
    // edit-driven pass.
    scheduleLint();
    if (!result) return;
    if (result.version === lastManifestVersion) return;
    lastManifestVersion = result.version;
    const next = result.manifest;
    set({ manifest: next });
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

  async openTab(path: string, hydrate?: HydrateTab) {
    const manifest = get().manifest;
    if (!manifest) return;
    const entry = findEntry(manifest, path);
    if (!entry) return;
    const tabs = get().tabs;
    const existingIndex = tabs.findIndex((t) => t.path === path);
    if (existingIndex !== -1) {
      // Bare switch (file already open) — measured separately because
      // it skips the disk read and is the much faster path.
      const start = perfNow();
      set({ activeTabIndex: existingIndex });
      logDuration(`file-switch (cached) ${path}`, start);
      return;
    }
    // Read body fresh from disk for the new tab. Parse the leading
    // frontmatter so the editor sees the body sans-fence and the panel
    // sees the structured map. The full file is reassembled at save time.
    const start = perfNow();
    const content = await window.skrive.fs.readFile(manifest.root, path);
    const parsed = parseFrontmatter(content.body);
    const newTab: Tab = {
      path,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      dirty: false,
      diskHash: content.hash,
      conflict: false,
      layoutMode: hydrate?.applyOverrides
        ? hydrate.layoutMode
        : DEFAULT_LAYOUT_MODE,
      splitDividerRatio: hydrate?.applyOverrides
        ? hydrate.splitDividerRatio
        : DEFAULT_SPLIT_RATIO,
      cursorLine: hydrate?.applyOverrides ? hydrate.cursorLine : 1,
      cursorColumn: hydrate?.applyOverrides ? hydrate.cursorColumn : 0,
      scrollTop: hydrate?.applyOverrides ? hydrate.scrollTop : 0,
      pendingSelection: null,
      diff: null
    };
    const nextTabs = [...tabs, newTab];
    set({ tabs: nextTabs, activeTabIndex: nextTabs.length - 1 });
    if (!hydrate?.applyOverrides) {
      scheduleImmediateSave(get);
      // Record in the LRU only on user-driven opens (not session
      // restore). The switcher reads this list as the empty-query
      // default; including session-restore openings would noise it up.
      usePreferencesStore.getState().recordRecentFile(manifest.root, path);
    }
    logDuration(`file-switch (cold) ${path}`, start);
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
    scheduleImmediateSave(get);
  },

  switchTab(index: number) {
    const { tabs } = get();
    if (index < 0 || index >= tabs.length) return;
    set({ activeTabIndex: index });
    scheduleImmediateSave(get);
  },

  async openTabAtLine(path, line, column, length) {
    await get().openTab(path);
    const { tabs } = get();
    const i = tabs.findIndex((t) => t.path === path);
    if (i < 0) return;
    pendingSelectionCounter += 1;
    const sel: PendingSelection = {
      line: Math.max(line, 1),
      column: Math.max(column, 0),
      length: Math.max(length, 0),
      nonce: pendingSelectionCounter
    };
    const nextTabs = tabs.slice();
    nextTabs[i] = { ...tabs[i]!, pendingSelection: sel };
    set({ tabs: nextTabs, activeTabIndex: i, activeView: 'editor' });
  },

  clearPendingSelection(index) {
    const { tabs } = get();
    const tab = tabs[index];
    if (!tab || !tab.pendingSelection) return;
    const nextTabs = tabs.slice();
    nextTabs[index] = { ...tab, pendingSelection: null };
    set({ tabs: nextTabs });
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
    // Drive lint off the edit (debounced, off-thread) rather than waiting for
    // autosave -> watcher -> manifest refresh — findings follow a typing pause
    // directly, and the body is read live from this tab.
    scheduleLint();
  },

  setTabLayoutMode(index: number, mode: LayoutMode) {
    const { tabs } = get();
    const tab = tabs[index];
    if (!tab || tab.layoutMode === mode) return;
    const nextTabs = tabs.slice();
    nextTabs[index] = { ...tab, layoutMode: mode };
    set({ tabs: nextTabs });
    scheduleImmediateSave(get);
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
    scheduleDebouncedSave(get);
  },

  setTabCursor(index: number, line: number, column: number) {
    const { tabs } = get();
    const tab = tabs[index];
    if (!tab) return;
    if (tab.cursorLine === line && tab.cursorColumn === column) return;
    const nextTabs = tabs.slice();
    nextTabs[index] = { ...tab, cursorLine: line, cursorColumn: column };
    set({ tabs: nextTabs });
    // Cursor is the blur/quit tier — don't schedule a write per
    // keystroke. Persistence flushes on tab close, project close,
    // and beforeunload.
  },

  setTabScrollTop(index: number, top: number) {
    const { tabs } = get();
    const tab = tabs[index];
    if (!tab) return;
    const clamped = top < 0 ? 0 : Math.round(top);
    if (tab.scrollTop === clamped) return;
    const nextTabs = tabs.slice();
    nextTabs[index] = { ...tab, scrollTop: clamped };
    set({ tabs: nextTabs });
    scheduleDebouncedSave(get);
  },

  async saveActiveTab() {
    // The explicit-save path (⌘S). Explicit intent overwrites: it does not
    // run the external-change guard, and it clears any standing conflict.
    const { manifest, tabs, activeTabIndex } = get();
    const tab = tabs[activeTabIndex];
    if (!manifest || !tab || !tab.dirty) return;
    // Clone before stamping so the live tab object isn't mutated mid-render.
    const writable: Tab = { ...tab, frontmatter: { ...tab.frontmatter } };
    const payload = buildSavePayload(writable);
    const hash = await window.skrive.fs.writeFile(manifest.root, tab.path, payload);
    const nextTabs = tabs.slice();
    nextTabs[activeTabIndex] = {
      ...writable,
      dirty: false,
      conflict: false,
      diskHash: hash
    };
    set({ tabs: nextTabs });
  },

  async saveAllDirty() {
    // The auto-save path. Non-destructive: before writing a tab it checks
    // whether the on-disk file drifted from our baseline and, if so, marks the
    // tab conflicted and surfaces an Overwrite prompt instead of clobbering.
    const { manifest, tabs } = get();
    if (!manifest) return;
    const writes: Array<Promise<void>> = [];
    const updatedTabs = tabs.slice();
    const conflicted: Tab[] = [];
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (!t || !t.dirty || t.conflict) continue;
      const changed = await window.skrive.fs.detectExternalChange(
        manifest.root,
        t.path,
        t.diskHash
      );
      if (changed) {
        updatedTabs[i] = { ...t, conflict: true };
        conflicted.push(t);
        continue;
      }
      const writable: Tab = { ...t, frontmatter: { ...t.frontmatter } };
      const payload = buildSavePayload(writable);
      const idx = i;
      writes.push(
        window.skrive.fs.writeFile(manifest.root, t.path, payload).then((hash) => {
          updatedTabs[idx] = { ...writable, dirty: false, diskHash: hash };
        })
      );
    }
    if (writes.length === 0 && conflicted.length === 0) return;
    await Promise.all(writes);
    set({ tabs: updatedTabs });
    for (const t of conflicted) {
      const name = t.path.split('/').pop() ?? t.path;
      notify.prompt(
        `"${name}" changed on disk outside Skrive — your edits are kept here.`,
        'Overwrite',
        () => useProjectStore.getState().forceSaveTab(t.path)
      );
    }
  },

  async forceSaveTab(path: string) {
    // Overwrite the on-disk file with the editor's version, resolving a
    // conflict. Invoked from the Overwrite prompt.
    const { manifest, tabs } = get();
    if (!manifest) return;
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;
    const writable: Tab = { ...tab, frontmatter: { ...tab.frontmatter } };
    const payload = buildSavePayload(writable);
    const hash = await window.skrive.fs.writeFile(manifest.root, path, payload);
    const nextTabs = get().tabs.slice();
    const j = nextTabs.findIndex((t) => t.path === path);
    const existing = nextTabs[j];
    if (existing) {
      nextTabs[j] = {
        ...existing,
        body: writable.body,
        frontmatter: writable.frontmatter,
        dirty: false,
        conflict: false,
        diskHash: hash
      };
      set({ tabs: nextTabs });
    }
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
    if (get().sidebarVisible === v) return;
    set({ sidebarVisible: v });
    scheduleImmediateSave(get);
  },

  toggleSidebar() {
    set({ sidebarVisible: !get().sidebarVisible });
    scheduleImmediateSave(get);
  },

  setSidebarWidth(width: number) {
    const clamped = clampSidebarWidth(width);
    if (get().sidebarWidth === clamped) return;
    set({ sidebarWidth: clamped });
    scheduleDebouncedSave(get);
  },

  // ============================ Workspace view ============================

  setActiveView(view: WorkspaceView) {
    if (get().activeView === view) return;
    set({ activeView: view });
    // Workspace view isn't part of the persisted ProjectUiState — it
    // resets on every open. No save scheduled.
  },

  toggleSettings() {
    const next = get().activeView === 'settings' ? 'editor' : 'settings';
    set({ activeView: next });
  },

  // ============================ Project state flush ============================

  async persistProjectStateNow() {
    if (debouncedSaveTimer) {
      clearTimeout(debouncedSaveTimer);
      debouncedSaveTimer = null;
    }
    const state = get();
    if (!state.manifest) return;
    const snapshot = snapshotProjectState(state);
    if (!snapshot) return;
    try {
      await window.skrive.persistence.saveProjectState(
        state.manifest.root,
        snapshot
      );
    } catch (err) {
      logProjectError('persistProjectStateNow', err);
    }
    // Also wait on whatever the last immediate-save scheduled, so the
    // caller can rely on "everything is on disk" after this resolves.
    try {
      await lastImmediateSave;
    } catch {
      // already logged
    }
  },

  // ============================ Backlinks panel ============================

  setBacklinksPanelOpen(v: boolean) {
    if (v) {
      set({
        backlinksPanelOpen: true,
        frontmatterPanelOpen: false,
        historyPanelOpen: false
      });
    } else {
      set({ backlinksPanelOpen: false });
    }
  },

  toggleBacklinksPanel() {
    const next = !get().backlinksPanelOpen;
    if (next) {
      set({
        backlinksPanelOpen: true,
        frontmatterPanelOpen: false,
        historyPanelOpen: false
      });
    } else {
      set({ backlinksPanelOpen: false });
    }
  },

  // ============================ Frontmatter panel ============================

  setFrontmatterPanelOpen(v: boolean) {
    if (v) {
      set({
        frontmatterPanelOpen: true,
        backlinksPanelOpen: false,
        historyPanelOpen: false
      });
    } else {
      set({ frontmatterPanelOpen: false });
    }
  },

  toggleFrontmatterPanel() {
    const next = !get().frontmatterPanelOpen;
    if (next) {
      set({
        frontmatterPanelOpen: true,
        backlinksPanelOpen: false,
        historyPanelOpen: false
      });
    } else {
      set({ frontmatterPanelOpen: false });
    }
  },

  closeFrontmatterPanel() {
    set({ frontmatterPanelOpen: false });
  },

  // ============================ Rename ============================

  openRenameModal(path) {
    set({ renameModalPath: path });
  },

  closeRenameModal() {
    set({ renameModalPath: null });
  },

  async commitRename(oldPath, newPath) {
    const manifest = get().manifest;
    if (!manifest) return;
    if (oldPath === newPath) return;
    // Flush dirty state on the renamed tab first so an in-flight
    // edit doesn't get clobbered when the renderer reopens it under
    // the new path. Best-effort — a failed flush is noisier than a
    // failed rename and the user can retry.
    const { tabs } = get();
    const renamedIndex = tabs.findIndex((t) => t.path === oldPath);
    if (renamedIndex >= 0) {
      const renamed = tabs[renamedIndex];
      if (renamed?.dirty) {
        try {
          const writable: Tab = {
            ...renamed,
            frontmatter: { ...renamed.frontmatter }
          };
          const payload = buildSavePayload(writable);
          await window.skrive.fs.writeFile(manifest.root, oldPath, payload);
        } catch (err) {
          logProjectError('flush before rename', err);
        }
      }
    }
    await window.skrive.linkGraph.renameWithReferences(oldPath, newPath);
    // The watcher's add+unlink events refresh the manifest, but we
    // also need to repoint the open tab at its new path so the
    // editor doesn't try to load from the gone-away `oldPath`.
    {
      const { tabs: latest, activeTabIndex } = get();
      const i = latest.findIndex((t) => t.path === oldPath);
      if (i >= 0) {
        const next = latest.slice();
        const renamed = latest[i]!;
        next[i] = { ...renamed, path: newPath };
        set({ tabs: next });
        // If the renamed file was the active tab, focus stays on it
        // — activeTabIndex doesn't move because we mutated in place.
        void activeTabIndex;
      }
    }
    await get().refreshManifest();
  },

  // ============================ History panel ============================

  setHistoryPanelOpen(v: boolean) {
    if (v) {
      set({
        historyPanelOpen: true,
        frontmatterPanelOpen: false,
        backlinksPanelOpen: false
      });
      void get().refreshHistory();
    } else {
      set({ historyPanelOpen: false });
    }
  },

  toggleHistoryPanel() {
    const next = !get().historyPanelOpen;
    if (next) {
      set({
        historyPanelOpen: true,
        frontmatterPanelOpen: false,
        backlinksPanelOpen: false
      });
      void get().refreshHistory();
    } else {
      set({ historyPanelOpen: false });
    }
  },

  closeHistoryPanel() {
    set({ historyPanelOpen: false });
  },

  setHistoryPairBaseId(id) {
    set({ historyPairBaseId: id });
  },

  async refreshHistory() {
    const tab = selectActiveTab(get());
    if (!tab) {
      set({ historyOfActive: [] });
      return;
    }
    try {
      const rows = await window.skrive.history.listForFile(tab.path);
      // Drop the result if the active tab changed mid-fetch.
      const after = selectActiveTab(get());
      if (!after || after.path !== tab.path) return;
      set({ historyOfActive: rows });
    } catch (err) {
      logProjectError('history:listForFile', err);
      set({ historyOfActive: [] });
    }
  },

  async openDiffForEntry(entry, baseline) {
    const { tabs, activeTabIndex } = get();
    const tab = tabs[activeTabIndex];
    if (!tab) return;
    if (tab.layoutMode === 'split') return;
    const restoreMode: 'raw' | 'preview' =
      tab.layoutMode === 'preview' ? 'preview' : 'raw';
    const diffMode: 'diff-raw' | 'diff-preview' =
      restoreMode === 'preview' ? 'diff-preview' : 'diff-raw';
    try {
      const beforeEntry: HistoryEntry = baseline ?? entry;
      const afterEntry: HistoryEntry | null = baseline ? entry : null;
      const [first, second] = await Promise.all([
        resolveDiffSide(tab.path, beforeEntry),
        afterEntry ? resolveDiffSide(tab.path, afterEntry) : resolveCurrentSide(tab)
      ]);
      const [left, right] =
        first.timestampMs <= second.timestampMs
          ? [first, second]
          : [second, first];
      const rows = await computeLineDiff(left.content, right.content);
      // Re-check active tab in case it changed mid-fetch.
      const stateAfter = get();
      const current = stateAfter.tabs[stateAfter.activeTabIndex];
      if (!current || current.path !== tab.path) return;
      const nextTabs = stateAfter.tabs.slice();
      nextTabs[stateAfter.activeTabIndex] = {
        ...current,
        diff: {
          before: left,
          after: right,
          rows,
          dividerRatio: 0.5,
          restoreMode,
          diffMode
        }
      };
      set({
        tabs: nextTabs,
        historyPairBaseId: null,
        historyPanelOpen: false
      });
    } catch (err) {
      logProjectError('openDiffForEntry', err);
    }
  },

  closeDiff() {
    const { tabs, activeTabIndex } = get();
    const tab = tabs[activeTabIndex];
    if (!tab || !tab.diff) return;
    const nextTabs = tabs.slice();
    nextTabs[activeTabIndex] = { ...tab, diff: null };
    set({ tabs: nextTabs });
  },

  setTabDiffMode(index, mode) {
    const { tabs } = get();
    const tab = tabs[index];
    if (!tab || !tab.diff || tab.diff.diffMode === mode) return;
    const nextTabs = tabs.slice();
    nextTabs[index] = { ...tab, diff: { ...tab.diff, diffMode: mode } };
    set({ tabs: nextTabs });
  },

  setTabDiffDividerRatio(index, ratio) {
    const { tabs } = get();
    const tab = tabs[index];
    if (!tab || !tab.diff) return;
    const clamped = clampRatio(ratio);
    if (tab.diff.dividerRatio === clamped) return;
    const nextTabs = tabs.slice();
    nextTabs[index] = { ...tab, diff: { ...tab.diff, dividerRatio: clamped } };
    set({ tabs: nextTabs });
  },

  async createManualCheckpoint(name) {
    const { manifest, tabs, activeTabIndex } = get();
    const tab = tabs[activeTabIndex];
    if (!manifest || !tab) return;
    if (get().historyMode !== 'checkpoint') return;
    const writable: Tab = { ...tab, frontmatter: { ...tab.frontmatter } };
    const payload = buildSavePayload(writable);
    await window.skrive.history.createManualCheckpoint(
      tab.path,
      name,
      payload
    );
    void get().refreshHistory();
  },

  // ============================ Lint ============================

  async refreshLint() {
    const manifest = get().manifest;
    if (!manifest) {
      if (get().lintReport !== null) set({ lintReport: null });
      return;
    }
    // Single-flight: a trigger that lands while a pass is running queues exactly
    // one rerun for when it finishes, so passes never overlap on the main thread.
    if (lintInFlight) {
      lintRerunQueued = true;
      return;
    }
    lintInFlight = true;
    const start = perfNow();
    // True once the worker post succeeds — ownership of the single-flight latch
    // transfers to handleLintResult, so `finally` must not clear it.
    let posted = false;
    try {
      const ipcStart = perfNow();
      const [deadLinks, orphanedFiles] = await Promise.all([
        window.skrive.linkGraph.getDeadLinks(),
        window.skrive.linkGraph.getOrphanedFiles()
      ]);
      logDuration('lint ipc (deadlinks+orphans)', ipcStart);
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
      // Drop cached bodies for paths the watcher flagged dirty since the last
      // pass, so an externally-changed (or just-saved-then-closed) file re-reads.
      for (const p of watchDirtyPaths) closedBodyCache.delete(p);
      watchDirtyPaths.clear();
      // Closed files: serve from cache, read only the misses. During editing no
      // closed file changes, so this reads nothing and the pass stays cheap.
      // Reads run in parallel — a serial await per file made cold lint ~5ms × N
      // (one IPC round-trip each), blowing the budget past ~20 files.
      const readStart = perfNow();
      const toRead = manifest.files.filter(
        (f) => !bodies.has(f.path) && !closedBodyCache.has(f.path)
      );
      const reads = await Promise.all(
        toRead.map(async (file) => {
          try {
            const content = await window.skrive.fs.readFile(
              manifest.root,
              file.path
            );
            return [file.path, parseFrontmatter(content.body).body] as const;
          } catch {
            // File vanished mid-scan; leave it out — engine treats
            // missing as empty.
            return null;
          }
        })
      );
      for (const r of reads) {
        if (r) closedBodyCache.set(r[0], r[1]);
      }
      logDuration(`lint reads (${toRead.length} files)`, readStart);
      // Fold cached closed-file bodies into the map the engine reads from.
      for (const file of manifest.files) {
        if (bodies.has(file.path)) continue;
        const cached = closedBodyCache.get(file.path);
        if (cached !== undefined) bodies.set(file.path, cached);
      }
      // If the project changed underneath us mid-gather, drop this pass.
      if (get().manifest?.root !== manifest.root) return;
      if (lintWorker) {
        // Diff the desired body map against what the worker already holds, so
        // only changed bodies cross postMessage. String identity short-circuits
        // the common case: an untouched tab or closed-file body is the same
        // reference as last pass and is excluded, so a keystroke ships one
        // entry. The first pass after a (re)spawn sees an empty mirror and
        // ships everything once.
        const delta: Array<[string, string]> = [];
        for (const [path, body] of bodies) {
          if (sentBodies.get(path) !== body) delta.push([path, body]);
        }
        const removed: string[] = [];
        for (const path of sentBodies.keys()) {
          if (!bodies.has(path)) removed.push(path);
        }
        // Ship the manifest only when its identity changed since the worker's
        // last pass — the worker caches it, so during prose typing (manifest
        // unchanged) we send null and skip cloning ~95 entries. Identity is
        // stable because refreshManifest only swaps a new manifest in on a real
        // version bump.
        const manifestToSend = manifest === sentManifest ? null : manifest;
        // Hand the engine off-thread. The result lands in handleLintResult,
        // which sets lintReport and releases the single-flight latch — so we
        // do NOT clear lintInFlight in `finally` once the post succeeds.
        lintSeq += 1;
        lintRequestRoot = manifest.root;
        lintRequestStart = start;
        // postMessage clones its payload synchronously on the main thread, so
        // time it: this is the only part of an off-thread pass that can still
        // stutter typing. With the manifest cached worker-side, a typing pass
        // now clones only the one-entry body delta.
        const postStart = perfNow();
        lintWorker.postMessage({
          type: 'run',
          seq: lintSeq,
          manifest: manifestToSend,
          deadLinks,
          orphanedFiles,
          delta,
          removed
        });
        logDuration(
          `lint post (manifest ${manifestToSend ? 'sent' : 'cached'}, delta ${delta.length}, removed ${removed.length})`,
          postStart
        );
        // The worker now holds exactly `bodies` + this manifest; adopt both as
        // the new mirror.
        sentBodies = bodies;
        sentManifest = manifest;
        posted = true;
      } else {
        // Degraded fallback: worker never came up, run the pure engine here.
        const report = runProjectLint({
          manifest,
          bodies,
          deadLinks,
          orphanedFiles
        });
        if (get().manifest?.root !== manifest.root) return;
        set({ lintReport: report });
        logDuration(
          `lint (${manifest.files.length} files, ${report.findings.length} findings)`,
          start
        );
      }
    } catch (err) {
      logProjectError('refreshLint', err);
    } finally {
      // When a worker pass is in flight its result handler owns the latch;
      // only the synchronous paths (fallback, error, early return) release it.
      if (!posted) {
        lintInFlight = false;
        if (lintRerunQueued) {
          lintRerunQueued = false;
          void get().refreshLint();
        }
      }
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
