// The project store — zustand, single source of truth for the open
// project, the live document, the working set, and sidebar visibility/width.
//
// SKR-243 retires the tabs layer for the working-set model
// (planning/chrome-navigation-model.md): exactly one fully-hydrated live
// document, a bounded LRU working set of recently open documents (entry 0 =
// the live doc; each entry keeps only path + cheap view state), and a
// browser-style trail of document visits behind ⌘⇧[ / ⌘⇧]. Switching
// flushes + autosaves the live doc (the old closeTab save path), demotes it
// to its working-set entry, and hydrates the target.
//
// Per-project persistence (Phase 9; schemaVersion 2 since SKR-243): the
// working set, per-entry cursor/scroll/layout, and sidebar visibility/width
// are reloaded from `{userData}/projects/{hash}.json` on open and written
// back via three tiers — immediate (switch, layout, sidebar visibility),
// debounced 1s (scroll, split-divider drag, sidebar width drag), and
// blur/quit (cursor position).

import { create } from 'zustand';
import {
  defaultProjectUiState,
  migrateProjectUiState,
  type FileEntry,
  type FrontmatterMap,
  type HistoryEntry,
  type HistoryMode,
  type LineDiffRow,
  type ProjectChange,
  type ProjectLintReport,
  type ProjectManifest,
  type ProjectUiState,
  type ProjectUiStateV1,
  type WorkingSetEntryState
} from '@skrive/shared';
import type { LayoutMode, SidebarSortKey } from '@skrive/shared';
import {
  EMPTY_TRAIL,
  peekVisit,
  promoteEntry,
  pruneTrail,
  pushVisit,
  renameInTrail,
  type NavTrail
} from './working-set';
import { computeLineDiff } from '../lib/diff/line-diff';
import { parseFrontmatter } from '../lib/frontmatter';
import { buildSavePayload, fileMode, type EditorMode } from './save';
import { generateBlockId, type Document } from '../lib/blockmodel';
// history.ts is model-pure (zero DOM imports), so the store can hold DocHistory
// instances without pulling the surface's DOM modules into its graph.
import { DocHistory } from '../lib/blocksurface/history';
import {
  folioToModel,
  modelToFolio,
  generateDocId,
  parseFolio,
  serializeFolio,
  FolioForwardError,
  type FolioDocument,
  type FolioMeta
} from '../lib/folio';
import { importKind, sourceToModel } from '../lib/import';
import {
  EXPORT_FORMATS,
  exportFolio,
  exportTargetPath,
  type ExportFormatId
} from '../lib/export';
import { stripFolioExtension } from '../lib/title';
import { bytesToBase64, imagePasteTarget } from '../lib/clipboard/pasteImage';
import { runProjectLint } from '../lib/lint';
import type { LintWorkerResponse } from '../lib/lint/lint-worker-protocol';
import { flushActiveEditor } from '../components/editor/active-editor';
import { notify } from '../lib/notify';
import { logDuration, now as perfNow } from '../lib/perf';
import {
  projectModel,
  spawnProjectModel,
  terminateProjectModel
} from '../lib/project-model/client';
import type { ModelUpdate } from '../lib/project-model/protocol';
import { usePreferencesStore } from './preferences';

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 260;

// Markdown-mode layout (SKR-197): raw source / split / rendered preview.
// layoutMode + splitDividerRatio ride on the document's working-set entry and
// persist per project. A new Markdown document opens in split (edit the source
// with a live preview beside it); `.folio` rich documents ignore layoutMode
// (they have a single editing surface).
const DEFAULT_LAYOUT_MODE: LayoutMode = 'split';
const DEFAULT_SPLIT_RATIO = 0.5;
const DEBOUNCED_SAVE_MS = 1000;

export type WorkspaceView = 'editor' | 'settings';

/** The selectable panes in the Settings view. Kept here (not in the
 *  component) so callers can deep-link to a section through the store —
 *  e.g. the "Update available" toast opening straight to `'updates'`. */
export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'writing'
  | 'license'
  | 'updates'
  | 'about';

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

/** Active diff overlay on the live document. Closing the diff (Escape / X)
 *  returns to the editor; switching documents discards it (diff is an
 *  ephemeral overlay, never persisted). */
export type DiffState = {
  before: DiffSide;
  after: DiffSide;
  rows: LineDiffRow[];
  dividerRatio: number;
  /** Sub-mode controlling DiffView's pane content (rendered vs raw text). */
  diffMode: 'diff-raw' | 'diff-preview';
};

/** The one fully-hydrated document (model, undo history, panels feed off
 *  it). Everything else the session remembers is a WorkingSetEntryState —
 *  path + cheap view state — hydrated back into this shape on switch. */
export type LiveDoc = {
  path: string;
  /** The editing path this document routes through, decided once at open from the
   *  file extension (SKR-196). `markdown` edits text and saves text -> text;
   *  `rich` edits the block model and saves the native `.folio` format. */
  mode: EditorMode;
  /** Body without the leading frontmatter block. The editor reads/writes
   *  this; the full file is reassembled at save time. Markdown mode only. */
  body: string;
  /** Parsed YAML frontmatter for the file. Populated on open; mutated
   *  by the FrontmatterPanel; auto-stamped fields refreshed on save. */
  frontmatter: FrontmatterMap;
  /** The canonical block model for a `rich` (`.folio`) document — the
   *  model-mode analogue of `body`. Absent in markdown mode. Set on open,
   *  synced from the surface on edit, serialized to `.folio` on save. */
  model?: Document;
  /** Document identity for a `rich` document (folio schema §3): read from the
   *  file on open, minted once on create, written back unchanged. Absent on
   *  markdown. */
  docId?: string;
  /** Document metadata for a `rich` document (title, createdAt, preserved
   *  unknowns). Absent in markdown mode. */
  docMeta?: FolioMeta;
  /** Session-scoped undo history for a `rich` document (SKR-179). BlockEditor
   *  remounts per document switch (`key` per path) and rebuilds its surface, so
   *  the history lives here — same lifetime as `model`, whose snapshots it
   *  references — and is handed to each new surface. In-memory only, never
   *  persisted; demote-then-rehydrate re-parses the model, so a document
   *  correctly starts a fresh history when it comes back. */
  history?: DocHistory;
  dirty: boolean;
  /** SHA-256 of the file as last loaded or saved. Baseline for external-change
   *  detection — compared against the on-disk file before an auto-save so we
   *  don't silently clobber an edit made outside Skrive. Not persisted. */
  diskHash: string;
  /** Set when an auto-save found the file changed on disk. Auto-save then
   *  skips the document (keeping it dirty) until the writer resolves it via
   *  Overwrite or an explicit ⌘S. Not persisted. */
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
   *  area renders DiffView in place of the editor. */
  diff: DiffState | null;
};

type State = {
  manifest: ProjectManifest | null;
  /** The one hydrated document, or null when the working set is empty.
   *  Invariant: `liveDoc` is non-null iff `workingSet` is non-empty, and
   *  `liveDoc.path === workingSet[0].path`. */
  liveDoc: LiveDoc | null;
  /** Bounded LRU of recently open documents, most recent first; entry 0
   *  mirrors the live doc (its view-state fields there refresh on demote
   *  and on persistence snapshots — while live, the LiveDoc is canonical).
   *  One array, three views: the summon fan, the switcher's empty state,
   *  and (Stage 2) the sidebar desk. */
  workingSet: WorkingSetEntryState[];
  /** Browser-style trail of document visits behind ⌘⇧[ / ⌘⇧]. A trail,
   *  not a state: separate from the working set on purpose. Session-only. */
  trail: NavTrail;
  loading: boolean;

  sidebarVisible: boolean;
  sidebarWidth: number;

  /** Project-relative file paths pinned to the sidebar's Favorites zone,
   *  in pin order. Mirrors SidebarState.pinned; persisted per-project. */
  pinned: string[];

  /** How the "All" file tree is ordered. Persisted per-project. */
  sortKey: SidebarSortKey;

  /** Floating top-right backlinks panel (phase 6). Toggled from the
   *  Header; reads `linkGraph.getBacklinks(activeTab.path)` on open. */
  backlinksPanelOpen: boolean;

  /** Floating top-right frontmatter editor (phase 7). Toggled from the
   *  Header's FM·N indicator or via ⌘⇧F. Mutually exclusive with the
   *  backlinks panel — opening one closes the other. */
  frontmatterPanelOpen: boolean;

  /** Path of the file currently being renamed, or null when no
   *  rename modal is open. Lives at the project level so the modal
   *  doesn't lose its target if the live doc changes mid-flight. */
  renameModalPath: string | null;

  /** Floating top-right history list (phase 10). One row per git
   *  commit or checkpoint touching the live doc. Mutually exclusive
   *  with backlinks + frontmatter. */
  historyPanelOpen: boolean;
  /** Project-level history backend, decided at project:open. Drives
   *  the panel's mode badge and gates the manual-checkpoint action. */
  historyMode: HistoryMode | null;
  /** History rows for the live doc. Refreshed on document switch + on
   *  watcher events that touch its path. */
  historyOfActive: HistoryEntry[];
  /** The "baseline" entry for shift-click pair compares. Stashed by
   *  every single click; consumed by the next shift-click. */
  historyPairBaseId: string | null;

  /** What's filling the workspace area. `'editor'` is the normal
   *  SplitView; `'settings'` is the project-scoped Settings page,
   *  invoked via ⌘, (Phase 9). Resets to `'editor'` on every project
   *  open / close. */
  activeView: WorkspaceView;

  /** One-shot request to open Settings at a specific section. Set by
   *  `openSettings(section)`, read once by `SettingsView`, then cleared
   *  via `clearSettingsSection()`. Null when there's no pending deep-link
   *  (Settings then opens on its default / last-in-session section). */
  settingsSection: SettingsSection | null;

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

  /** Switch to `path`: flush + autosave the live doc, demote it to its
   *  working-set entry, hydrate the target (restoring its remembered view
   *  state), promote it to entry 0, and record the visit on the trail.
   *  No-op when `path` is already live. Calls serialize — a switch that
   *  lands mid-switch queues behind it, so rapid switching never
   *  interleaves saves and hydrations. */
  openDoc(path: string, opts?: OpenDocOptions): Promise<void>;
  /** Open `path` and request a selection spanning `length` UTF-16 code
   *  units starting at (`line`, `column`). Used by the search modal and
   *  any "jump to here" surface. */
  openDocAtLine(
    path: string,
    line: number,
    column: number,
    length: number
  ): Promise<void>;
  /** Walk the trail one visit back / forward (⌘⇧[ / ⌘⇧]). */
  historyBack(): Promise<void>;
  historyForward(): Promise<void>;
  /** Cleared from the editor after the selection has been applied so a
   *  subsequent re-render with the same nonce doesn't re-apply. */
  clearPendingSelection(): void;

  // Live-doc mutators. Each takes the document's path and no-ops on a
  // mismatch, so a stale editor callback that outlives a switch can never
  // write another document's state.
  setLiveDocBody(path: string, next: string): void;
  /** Sync the edited block model back onto a rich (`.folio`) live doc. The
   *  model-mode analogue of setLiveDocBody; marks dirty, skips Markdown lint. */
  setLiveDocModel(path: string, next: Document): void;
  /** Set the Markdown-mode layout (raw / split / preview). Persisted. */
  setLiveDocLayoutMode(path: string, mode: LayoutMode): void;
  /** Set the split-view divider ratio (raw | preview). Debounced-persisted. */
  setLiveDocSplitDividerRatio(path: string, ratio: number): void;
  setLiveDocCursor(path: string, line: number, column: number): void;
  setLiveDocScrollTop(path: string, top: number): void;

  /** Explicit ⌘S save of the live doc. Overwrites without the external-
   *  change guard and clears any standing conflict. */
  saveLiveDoc(): Promise<void>;
  /** The auto-save path: write the live doc if dirty, with the external-
   *  change guard (conflicts surface an Overwrite prompt instead of
   *  clobbering). Demoted documents are already flushed on switch. */
  saveDirty(): Promise<void>;
  /** Overwrite the on-disk file with the editor's version, resolving an
   *  external-change conflict. Invoked from the Overwrite prompt. */
  forceSaveLiveDoc(path: string): Promise<void>;

  createFile(relPath: string): Promise<void>;
  /** Create a fresh, empty `.txt` plain-text file (extension appended if absent),
   *  then open it in plain-text mode. */
  createTextFile(relPath: string): Promise<void>;
  /** Create a fresh, empty native `.folio` document (mints a docId + createdAt),
   *  then open it. The extension is appended if absent. */
  createFolioDocument(relPath: string): Promise<void>;
  createDirectory(relPath: string): Promise<void>;
  /** Export a native `.folio` document to an open format (Markdown / HTML / TXT /
   *  RTF), writing the result into the project folder beside the source. Honest,
   *  lossy-where-the-target-can't export — not a fidelity contract. Never clobbers
   *  an existing file (see `exportTargetPath`). */
  exportDocument(path: string, format: ExportFormatId): Promise<void>;
  /** The bespoke surface's paste-image write delegate (SKR-175): writes `bytes`
   *  to a sibling `assets/` folder next to `docPath` under `filename`, and
   *  resolves with the Markdown link path (relative to `docPath`) to splice at
   *  the caret. Rejects (no manifest, or the IPC write fails) rather than
   *  swallowing the error — the surface's catch is what toasts, so the failure
   *  isn't reported twice. */
  pasteImageAsset(docPath: string, filename: string, bytes: Uint8Array): Promise<string>;
  /** Convert an open-format source file (Markdown / HTML / plain text) into a
   *  new native `.folio` document and open it. The explicit "Make this a Skrive
   *  document" upgrade: it mints a fresh docId, writes a *new* `.folio`, and
   *  leaves the source file untouched — never a silent in-place enrichment (the
   *  portability rule). No-ops for a path that isn't a convertible source. */
  convertToFolio(path: string): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
  deleteDirectory(relPath: string): Promise<void>;

  setSidebarVisible(v: boolean): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;
  /** Pin or unpin a file path to the sidebar's Favorites zone. */
  togglePin(path: string): void;
  /** Set how the "All" file tree is ordered. */
  setSortKey(key: SidebarSortKey): void;

  setActiveView(view: WorkspaceView): void;
  toggleSettings(): void;
  /** Open Settings, optionally deep-linking to a specific section. */
  openSettings(section?: SettingsSection): void;
  /** Consume the one-shot `settingsSection` deep-link. */
  clearSettingsSection(): void;

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
   *  the file, rewrites every reference, and repoints the live doc, its
   *  working-set entry, and the trail at the new path. Refreshes the
   *  manifest from the watcher event afterwards. */
  commitRename(oldPath: string, newPath: string): Promise<void>;

  setHistoryPanelOpen(v: boolean): void;
  toggleHistoryPanel(): void;
  closeHistoryPanel(): void;
  setHistoryPairBaseId(id: string | null): void;
  /** Refresh history rows for the live doc. Called when the panel
   *  opens, when the live doc changes, and when the watcher reports
   *  a change to the active path. Best-effort. */
  refreshHistory(): Promise<void>;
  /** Flip the global git-history preference. Persists it, pushes it to the
   *  shell, updates the open project's effective history mode, and refreshes
   *  the history rows so the panel switches backends live. */
  setGitHistoryEnabled(enabled: boolean): Promise<void>;
  /** Render the diff overlay on the live doc. Single click passes
   *  `(entry, null)` — diff against current. Shift-click passes
   *  `(entry, baseline)` — pair-diff. Older side always lands on the
   *  "before" pane regardless of click order. */
  openDiffForEntry(
    entry: HistoryEntry,
    baseline: HistoryEntry | null
  ): Promise<void>;
  /** Close the diff overlay; restore the editor mode it replaced. */
  closeDiff(): void;
  setDiffMode(mode: 'diff-raw' | 'diff-preview'): void;
  setDiffDividerRatio(ratio: number): void;
  /** Pin the live doc's current contents as a manual checkpoint.
   *  No-op in git mode (the panel hides the action). */
  createManualCheckpoint(name: string): Promise<void>;

  /** Re-run the lint engine against the current manifest + live doc.
   *  Pulls deadLinks + orphanedFiles fresh from IPC. Safe to call when
   *  no project is open (no-op). */
  refreshLint(): Promise<void>;

  /** Replace the value of a frontmatter field on the live doc. New
   *  fields are inserted at the end of the map; existing fields are
   *  updated in place (preserving order on the wire). */
  updateLiveDocFrontmatter(key: string, value: unknown): void;
  /** Remove a frontmatter field from the live doc. */
  removeLiveDocFrontmatter(key: string): void;
  /** Rename a frontmatter key on the live doc. Silently no-ops on
   *  conflict — the panel's commitKey detects the no-op and reverts the
   *  input back to the original key. */
  renameLiveDocFrontmatterKey(oldKey: string, newKey: string): void;
};

type OpenDocOptions = {
  /** 'none' skips recording the visit on the trail — the back/forward
   *  walkers use it so walking doesn't rewrite the trail. Default 'push'. */
  nav?: 'push' | 'none';
  /** False for session restore, so restoring the last live doc doesn't
   *  count as a "recent file" visit in the app-wide LRU. Default true. */
  recordRecent?: boolean;
};

function clampSidebarWidth(w: number): number {
  if (Number.isNaN(w)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w));
}

// ============================ Persistence pipeline ============================
//
// Three save tiers per A3:
//   - Immediate: document switch, layout-mode, sidebar visibility.
//   - Debounced 1s: scroll, split-divider drag, sidebar width drag.
//   - Blur/quit: cursor position (saves on document switch, project
//     close, beforeunload).
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

// Closed-file body cache for lint. The live doc always supplies its in-memory
// body; the bodies of every other file change only via the watcher (demoted
// documents flush to disk on switch), which hands us the exact path. So we read
// each closed file once, cache it, and re-read only the paths the watcher
// reports dirty — during editing no closed file changes, so the per-pass disk
// reads (the cost the AST memo didn't cover) drop to zero.
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
// clone entirely. Identity is stable because applyModelUpdate only swaps in a new
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

/** The live doc's working-set entry, rebuilt from its current view state.
 *  Entry 0 in the persisted array (and after a demote) always comes through
 *  here so the LiveDoc stays canonical while hydrated. */
function entryFromLiveDoc(doc: LiveDoc): WorkingSetEntryState {
  return {
    path: doc.path,
    layoutMode: doc.layoutMode,
    cursor: { line: doc.cursorLine, column: doc.cursorColumn },
    scrollTop: doc.scrollTop,
    splitDividerRatio: doc.splitDividerRatio
  };
}

function snapshotProjectState(state: State): ProjectUiState | null {
  if (!state.manifest) return null;
  const config = state.manifest.config;
  return {
    schemaVersion: 2,
    projectPath: state.manifest.root,
    projectName:
      config.project.name ??
      basename(state.manifest.root) ??
      state.manifest.root,
    lastOpenedMs: Date.now(),
    sidebar: {
      visible: state.sidebarVisible,
      width: state.sidebarWidth,
      pinned: state.pinned,
      sortKey: state.sortKey
    },
    workingSet: state.workingSet.map((entry) =>
      state.liveDoc && entry.path === state.liveDoc.path
        ? entryFromLiveDoc(state.liveDoc)
        : entry
    )
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

// Coalesce watcher-driven model syncs. Each new file event resets the
// timer, so a run of autosaves (or any burst) collapses into one sync
// once the tree settles. Paths accumulate in `pendingWatchPaths` with
// their latest operation; the sync reads each changed file once and
// feeds it to the project-model worker (the renderer-side mirror of the
// shell's old watcher -> manifest patch path).
const pendingWatchPaths = new Map<string, 'upsert' | 'remove'>();

function scheduleWatchSync(getState: () => State & Actions): void {
  if (watchRefreshTimer) clearTimeout(watchRefreshTimer);
  watchRefreshTimer = setTimeout(() => {
    watchRefreshTimer = null;
    void syncWatchedChanges(getState);
  }, WATCH_REFRESH_DEBOUNCE_MS);
}

async function syncWatchedChanges(getState: () => State & Actions): Promise<void> {
  const manifest = getState().manifest;
  const client = projectModel();
  if (!manifest || !client) {
    pendingWatchPaths.clear();
    return;
  }
  const entries = Array.from(pendingWatchPaths.entries());
  pendingWatchPaths.clear();
  await Promise.all(
    entries.map(async ([path, op]) => {
      if (op === 'remove') {
        await client.remove(path);
        return;
      }
      try {
        const content = await window.skrive.fs.readFile(manifest.root, path);
        await client.upsert(path, modelSyncBody(fileMode(path), content.body), {
          modifiedMs: content.modifiedMs
        });
      } catch {
        // Vanished between the event and the read — drop instead.
        await client.remove(path);
      }
    })
  );
  // Always re-lint after a sync — a content change to a closed file bumps
  // no manifest version but can still move cross-file findings.
  scheduleLint();
}

function cancelWatchRefresh(): void {
  if (watchRefreshTimer) {
    clearTimeout(watchRefreshTimer);
    watchRefreshTimer = null;
  }
  pendingWatchPaths.clear();
}

/** Commit a worker-delivered manifest into the store: swap it in and drop
 *  vanished files from the working set and the trail (the model rule:
 *  deleted files drop out of both lists). The worker only delivers on a
 *  version bump, so every call here is a real structural change —
 *  content-only edits never reach this (and never re-render). */
function applyModelUpdate(
  update: ModelUpdate,
  get: () => State & Actions,
  set: (partial: Partial<State>) => void
): void {
  lastManifestVersion = update.version;
  const next = update.manifest;
  set({ manifest: next });
  pruneVanishedDocs(get, set, (path) =>
    next.files.some((f) => f.path === path)
  );
}

/** Drop working-set + trail entries whose file no longer exists. If the
 *  live doc itself vanished, fall back to hydrating the most recent
 *  survivor (or the empty state). Shared by the watcher path
 *  (applyModelUpdate) and the in-app delete actions. */
function pruneVanishedDocs(
  get: () => State & Actions,
  set: (partial: Partial<State>) => void,
  exists: (path: string) => boolean
): void {
  const { liveDoc, workingSet, trail } = get();
  const survivors = workingSet.filter((e) => exists(e.path));
  if (survivors.length !== workingSet.length) {
    set({ workingSet: survivors, trail: pruneTrail(trail, exists) });
  }
  if (liveDoc && !exists(liveDoc.path)) {
    // The live doc's file is gone: drop the hydrated state, then bring up
    // the next most recent document. The visit isn't re-pushed — the trail
    // already reflects where the writer has been.
    set({ liveDoc: null });
    const fallback = survivors[0];
    if (fallback) {
      void get()
        .openDoc(fallback.path, { nav: 'none', recordRecent: false })
        .catch((err) => logProjectError('openDoc (vanished fallback)', err));
    }
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
 *  live doc, exactly the bytes a save would emit. We re-stamp
 *  frontmatter on the fly via buildSavePayload so the diff matches
 *  what the next save writes. */
function resolveCurrentSide(doc: LiveDoc): DiffSide {
  const writable: LiveDoc = { ...doc, frontmatter: { ...doc.frontmatter } };
  return {
    content: buildSavePayload(writable),
    timestampMs: Date.now(),
    label: 'Current',
    source: 'current'
  };
}

// The body to feed the (Markdown-oriented) project model after writing a doc.
// Only a markdown document feeds its real bytes. A rich (`.folio`) or plain-text
// (`.txt`) one registers its path with an EMPTY body: the file stays in the
// manifest/sidebar, but its content is never parsed as Markdown for links or lint
// (the engine is catalog, never custodian — non-Markdown content is not the
// Markdown model's concern).
function modelSyncBody(mode: EditorMode, payload: string): string {
  return mode === 'markdown' ? payload : '';
}

// Write a `.folio` document to `relPath` and open it. Exclusive-create first so
// the path can't clobber an existing file, then the canonical bytes; register
// the path with an empty body (folio content is not the Markdown model's
// concern, see modelSyncBody). Shared by fresh-document creation and the
// `.md`/import -> `.folio` conversion, which differ only in how `doc` is built.
async function writeFolioAndOpen(
  get: () => State & Actions,
  manifestRoot: string,
  relPath: string,
  doc: FolioDocument
): Promise<void> {
  await window.skrive.fs.newFile(manifestRoot, relPath);
  await window.skrive.fs.writeFile(manifestRoot, relPath, serializeFolio(doc));
  await projectModel()?.upsert(relPath, '');
  await get().openDoc(relPath);
}

// ============================ Document switch ============================

// openDoc calls chain onto this promise so switches never interleave.
let switchChain: Promise<void> = Promise.resolve();

type SetState = (partial: Partial<State>) => void;

/** The actual switch: flush + save the outgoing live doc, demote it to its
 *  working-set entry, hydrate the target (restoring remembered view state),
 *  promote it to entry 0, record the visit. Runs inside `switchChain`. */
async function performOpenDoc(
  get: () => State & Actions,
  set: SetState,
  path: string,
  opts?: OpenDocOptions
): Promise<void> {
  const manifest = get().manifest;
  if (!manifest) return;
  if (get().liveDoc?.path === path) return;
  if (!findEntry(manifest, path)) return;
  const start = perfNow();

  // Drain the active surface's pending snapshot into the store before the
  // demote-save reads the body. The disk write below runs before the editor
  // unmounts, so its own cleanup flush would be too late — without this an
  // edit made inside the debounce/idle window is persisted stale on switch
  // (SKR-154 / F02). flush() is idempotent, so the unmount flush no-ops.
  flushActiveEditor();
  const outgoing = get().liveDoc;
  let workingSet = get().workingSet;
  if (outgoing) {
    if (outgoing.dirty) {
      // Best-effort flush before demote — the old closeTab save path.
      // Errors are logged, not fatal: the switch proceeds so the writer
      // isn't trapped in a document that can't save.
      try {
        const writable: LiveDoc = {
          ...outgoing,
          frontmatter: { ...outgoing.frontmatter }
        };
        const payload = buildSavePayload(writable);
        await window.skrive.fs.writeFile(manifest.root, outgoing.path, payload);
        void projectModel()?.upsert(
          outgoing.path,
          modelSyncBody(outgoing.mode, payload)
        );
      } catch (err) {
        console.error('[skrive] save-on-switch failed', err);
      }
    }
    // Demote: the hydrated state is dropped, the entry keeps the view state.
    const demoted = entryFromLiveDoc(outgoing);
    const i = workingSet.findIndex((e) => e.path === outgoing.path);
    workingSet = workingSet.slice();
    if (i >= 0) workingSet[i] = demoted;
    else workingSet.unshift(demoted);
  }

  // Read the target fresh from disk. A markdown file parses its leading
  // frontmatter so the editor sees the body sans-fence; a rich `.folio`
  // parses the native JSON into the block model and carries its identity
  // (docId / docMeta) alongside. The full file is reassembled at save time
  // by the mode's save path (stores/save).
  const mode = fileMode(path);
  const content = await window.skrive.fs.readFile(manifest.root, path);

  let contentFields: Pick<
    LiveDoc,
    'body' | 'frontmatter' | 'model' | 'docId' | 'docMeta' | 'history'
  >;
  if (mode === 'rich') {
    let folio: FolioDocument;
    try {
      folio = parseFolio(content.body);
    } catch (err) {
      // Never open a partial document. A forward-version / zip file is "made
      // by a newer Skrive"; anything else is a malformed file. Surface and
      // abort — the outgoing doc (already saved) stays live.
      const name = path.split('/').pop() ?? path;
      if (err instanceof FolioForwardError) {
        notify.warn(
          `"${name}" was made by a newer version of Skrive and can't be opened here.`
        );
      } else {
        notify.error(
          `"${name}" could not be opened: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }
    contentFields = {
      body: '',
      frontmatter: {},
      model: folioToModel(folio),
      docId: folio.docId,
      docMeta: folio.docMeta,
      history: new DocHistory()
    };
  } else if (mode === 'text' || mode === 'view') {
    // Plain text (`.txt`, SKR-204) and the read-only HTML viewer (`.html`,
    // SKR-205): the whole file is the body verbatim — no frontmatter parse
    // (a `.txt`'s leading `---` is content, not metadata; an `.html`'s bytes
    // are rendered as-is) and no block model. A view doc's body is never
    // edited or saved; it only feeds the viewer.
    contentFields = { body: content.body, frontmatter: {} };
  } else {
    const parsed = parseFrontmatter(content.body);
    contentFields = { body: parsed.body, frontmatter: parsed.frontmatter };
  }

  // Restore the document's remembered view state, if it still has an entry.
  const remembered = workingSet.find((e) => e.path === path);
  const liveDoc: LiveDoc = {
    path,
    mode,
    ...contentFields,
    dirty: false,
    diskHash: content.hash,
    conflict: false,
    layoutMode: remembered?.layoutMode ?? DEFAULT_LAYOUT_MODE,
    splitDividerRatio: remembered
      ? clampRatio(remembered.splitDividerRatio)
      : DEFAULT_SPLIT_RATIO,
    cursorLine: remembered?.cursor.line ?? 1,
    cursorColumn: remembered?.cursor.column ?? 0,
    scrollTop: remembered?.scrollTop ?? 0,
    pendingSelection: null,
    diff: null
  };

  set({
    liveDoc,
    workingSet: promoteEntry(workingSet, entryFromLiveDoc(liveDoc), get().pinned),
    ...(opts?.nav === 'none'
      ? {}
      : { trail: pushVisit(get().trail, path) })
  });
  scheduleImmediateSave(get);
  if (opts?.recordRecent !== false) {
    // App-wide LRU (the sidebar's Recents section reads it until the
    // Stage 2 desk replaces that section). Skipped on session restore so
    // reopening the app doesn't count as a visit.
    usePreferencesStore.getState().recordRecentFile(manifest.root, path);
  }
  logDuration(`file-switch ${path}`, start);
}

/** ⌘⇧[ / ⌘⇧]: move the trail cursor and hydrate that visit without
 *  re-recording it. The trail holds only existing files (pruned on every
 *  manifest change), so the peek is already the destination. */
async function walkTrail(
  get: () => State & Actions,
  set: SetState,
  dir: -1 | 1
): Promise<void> {
  const target = peekVisit(get().trail, dir);
  if (target === null) return;
  const index = get().trail.index + dir;
  await get().openDoc(target, { nav: 'none' });
  // Commit the cursor move only if the switch landed (a vanished file or
  // parse failure leaves the trail where it was).
  if (get().liveDoc?.path === target) {
    set({ trail: { ...get().trail, index } });
  }
}

export const useProjectStore = create<State & Actions>((set, get) => ({
  manifest: null,
  liveDoc: null,
  workingSet: [],
  trail: EMPTY_TRAIL,
  loading: false,

  sidebarVisible: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  pinned: [],
  sortKey: 'name',

  backlinksPanelOpen: false,
  frontmatterPanelOpen: false,
  historyPanelOpen: false,
  historyMode: null,
  historyOfActive: [],
  historyPairBaseId: null,
  renameModalPath: null,
  activeView: 'editor',
  settingsSection: null,
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
      // project before tearing it down. closeProject already saves the
      // live doc, but if the user goes File → Open without quitting,
      // the previous project's project.json could lose a debounced
      // sidebar/scroll write otherwise.
      await get().persistProjectStateNow();

      const prev = get().unsubscribeWatch;
      if (prev) prev();
      await window.skrive.project.unwatch();
      cancelWatchRefresh();
      resetLintReadCache();
      resetLintPipeline();

      // One batched read; the project-model worker derives manifest,
      // schema, and link graph from it renderer-side (Stage 0.4).
      const client = spawnProjectModel();
      const snapshot = await window.skrive.project.snapshot(path);
      const initial = await client.init(snapshot);
      const manifest = initial.manifest;
      lastManifestVersion = initial.version;
      // Subscribed after init so the handler only sees incremental
      // updates; the initial manifest is committed by the set() below.
      client.onModelUpdate((update) => applyModelUpdate(update, get, set));

      const unsubscribe = window.skrive.project.onChange((event) => {
        if (event.kind === 'ready') return;
        // Record which path changed so the next lint re-reads only that file
        // and serves the rest from the closed-body cache. (Dir events carry a
        // path too; tracking it is harmless — it just isn't a lintable file.)
        if ('path' in event) watchDirtyPaths.add(event.path);
        if (event.kind === 'add' || event.kind === 'change') {
          pendingWatchPaths.set(event.path, 'upsert');
        } else if (event.kind === 'unlink') {
          pendingWatchPaths.set(event.path, 'remove');
        }
        // Debounced: the app's own autosaves fire watcher events too, and an
        // undebounced sync per event would stack reads while the writer is
        // mid-keystroke. Coalesce to one sync once edits settle.
        scheduleWatchSync(get);
      });
      await window.skrive.project.watch(manifest.root);

      // Phase 9: pull the persisted UI state for this project before
      // committing the manifest, so the initial render lands with the
      // saved sidebar geometry / working set / cursor instead of
      // flashing defaults.
      const persisted = await window.skrive.persistence.loadProjectState(
        manifest.root
      );

      const sidebarState = persisted?.sidebar ?? {
        visible: true,
        width: SIDEBAR_DEFAULT_WIDTH,
        pinned: [],
        sortKey: 'name' as SidebarSortKey
      };

      // Phase 10: pull the project's history mode (git vs checkpoint)
      // up-front so HI button + history panel pick it up on first
      // render. Preferences are hydrated before any project opens (see
      // App.tsx boot order), so pushing the stored git-history preference
      // here is race-free; the shell returns the now-effective mode, which
      // forces checkpoint when the preference is off regardless of a
      // `.git/`. Best-effort — fall back to checkpoint if the IPC hiccups;
      // history listing degrades gracefully on either path.
      let historyMode: HistoryMode = 'checkpoint';
      try {
        historyMode = await window.skrive.history.setGitHistoryEnabled(
          usePreferencesStore.getState().gitHistoryEnabled
        );
      } catch (err) {
        logProjectError('history:setGitHistoryEnabled', err);
      }

      set({
        manifest,
        liveDoc: null,
        workingSet: [],
        trail: EMPTY_TRAIL,
        sidebarVisible: sidebarState.visible,
        sidebarWidth: clampSidebarWidth(sidebarState.width),
        pinned: sidebarState.pinned ?? [],
        sortKey: sidebarState.sortKey ?? 'name',
        activeView: 'editor',
        lintReport: null,
        historyMode,
        historyOfActive: [],
        historyPairBaseId: null,
        historyPanelOpen: false,
        unsubscribeWatch: unsubscribe,
        loading: false
      });

      // Restore the persisted working set, then hydrate only entry 0 (the
      // last live doc) — the other entries stay cold until visited, which
      // is the whole point of the working-set model. `migrated` may come
      // off disk as a v1 (tabs-era) file; the migration keeps the active
      // tab as entry 0.
      const migrated = migrateProjectUiState(
        // The shells return the state file opaquely, so a pre-SKR-243 file
        // arrives in the v1 (tabs) shape despite the wire type.
        persisted as ProjectUiState | ProjectUiStateV1 | null
      );
      if (migrated) {
        const entries = migrated.workingSet
          .filter((e) => manifest.files.some((f) => f.path === e.path))
          .map((e) => ({ ...e, splitDividerRatio: clampRatio(e.splitDividerRatio) }));
        set({ workingSet: entries });
        if (entries[0]) {
          await get().openDoc(entries[0].path, { recordRecent: false });
        }
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
    terminateProjectModel();
    // Flush the live doc + persist project UI state before clearing.
    await get().saveDirty();
    await get().persistProjectStateNow();
    usePreferencesStore.getState().setLastOpenedProject(null);
    set({
      manifest: null,
      liveDoc: null,
      workingSet: [],
      trail: EMPTY_TRAIL,
      activeView: 'editor',
      lintReport: null,
      historyMode: null,
      historyOfActive: [],
      historyPairBaseId: null,
      historyPanelOpen: false,
      unsubscribeWatch: null
    });
  },

  // ============================ Working set ============================

  async openDoc(path: string, opts?: OpenDocOptions) {
    // Serialize switches: a second openDoc that lands while one is mid-
    // flight (rapid fan/switcher/history use during a pending autosave)
    // queues behind it instead of interleaving the demote-save and the
    // hydration reads.
    const run = () => performOpenDoc(get, set, path, opts);
    const chained = switchChain.then(run, run);
    switchChain = chained.then(
      () => undefined,
      () => undefined
    );
    return chained;
  },

  async openDocAtLine(path, line, column, length) {
    await get().openDoc(path);
    const doc = get().liveDoc;
    if (!doc || doc.path !== path) return;
    pendingSelectionCounter += 1;
    const sel: PendingSelection = {
      line: Math.max(line, 1),
      column: Math.max(column, 0),
      length: Math.max(length, 0),
      nonce: pendingSelectionCounter
    };
    set({ liveDoc: { ...doc, pendingSelection: sel }, activeView: 'editor' });
  },

  async historyBack() {
    await walkTrail(get, set, -1);
  },

  async historyForward() {
    await walkTrail(get, set, 1);
  },

  clearPendingSelection() {
    const doc = get().liveDoc;
    if (!doc || !doc.pendingSelection) return;
    set({ liveDoc: { ...doc, pendingSelection: null } });
  },

  setLiveDocBody(path: string, next: string) {
    const doc = get().liveDoc;
    if (!doc || doc.path !== path) return;
    if (next === doc.body) return;
    set({ liveDoc: { ...doc, body: next, dirty: true } });
    // Drive lint off the edit (debounced, off-thread) rather than waiting for
    // autosave -> watcher -> manifest refresh — findings follow a typing pause
    // directly, and the body is read live from the store.
    scheduleLint();
  },

  setLiveDocModel(path: string, next: Document) {
    const doc = get().liveDoc;
    if (!doc || doc.path !== path) return;
    if (next === doc.model) return;
    set({ liveDoc: { ...doc, model: next, dirty: true } });
    // No scheduleLint: a `.folio` document is not Markdown, so the Markdown
    // lint/link engine does not apply to it.
  },

  setLiveDocLayoutMode(path: string, mode: LayoutMode) {
    const doc = get().liveDoc;
    if (!doc || doc.path !== path || doc.layoutMode === mode) return;
    set({ liveDoc: { ...doc, layoutMode: mode } });
    // A layout choice is a deliberate, immediate-tier preference.
    scheduleImmediateSave(get);
  },

  setLiveDocSplitDividerRatio(path: string, ratio: number) {
    const doc = get().liveDoc;
    if (!doc || doc.path !== path) return;
    const clamped = clampRatio(ratio);
    if (doc.splitDividerRatio === clamped) return;
    set({ liveDoc: { ...doc, splitDividerRatio: clamped } });
    // Drag: debounced tier, same as scroll/sidebar-width.
    scheduleDebouncedSave(get);
  },

  setLiveDocCursor(path: string, line: number, column: number) {
    const doc = get().liveDoc;
    if (!doc || doc.path !== path) return;
    if (doc.cursorLine === line && doc.cursorColumn === column) return;
    set({ liveDoc: { ...doc, cursorLine: line, cursorColumn: column } });
    // Cursor is the blur/quit tier — don't schedule a write per
    // keystroke. Persistence flushes on switch, project close, and
    // beforeunload.
  },

  setLiveDocScrollTop(path: string, top: number) {
    const doc = get().liveDoc;
    if (!doc || doc.path !== path) return;
    const clamped = top < 0 ? 0 : Math.round(top);
    if (doc.scrollTop === clamped) return;
    set({ liveDoc: { ...doc, scrollTop: clamped } });
    scheduleDebouncedSave(get);
  },

  async saveLiveDoc() {
    // The explicit-save path (⌘S). Explicit intent overwrites: it does not
    // run the external-change guard, and it clears any standing conflict.
    const { manifest, liveDoc } = get();
    if (!manifest || !liveDoc || !liveDoc.dirty) return;
    // Clone before stamping so the live object isn't mutated mid-render.
    const writable: LiveDoc = {
      ...liveDoc,
      frontmatter: { ...liveDoc.frontmatter }
    };
    const payload = buildSavePayload(writable);
    const hash = await window.skrive.fs.writeFile(
      manifest.root,
      liveDoc.path,
      payload
    );
    void projectModel()?.upsert(
      liveDoc.path,
      modelSyncBody(liveDoc.mode, payload)
    );
    // The doc may have advanced (or switched) while the write was in
    // flight; only commit the saved state onto the same document, and only
    // clear dirty when no newer content edit landed mid-write.
    const after = get().liveDoc;
    if (!after || after.path !== liveDoc.path) return;
    const advanced =
      after.body !== liveDoc.body || after.model !== liveDoc.model;
    set({
      liveDoc: {
        ...after,
        frontmatter: writable.frontmatter,
        dirty: advanced,
        conflict: false,
        diskHash: hash
      }
    });
  },

  async saveDirty() {
    // The auto-save path. Non-destructive: before writing it checks whether
    // the on-disk file drifted from our baseline and, if so, marks the doc
    // conflicted and surfaces an Overwrite prompt instead of clobbering.
    const { manifest, liveDoc } = get();
    if (!manifest || !liveDoc || !liveDoc.dirty || liveDoc.conflict) return;
    const changed = await window.skrive.fs.detectExternalChange(
      manifest.root,
      liveDoc.path,
      liveDoc.diskHash
    );
    const current = get().liveDoc;
    if (!current || current.path !== liveDoc.path) return;
    if (changed) {
      set({ liveDoc: { ...current, conflict: true } });
      const name = liveDoc.path.split('/').pop() ?? liveDoc.path;
      notify.prompt(
        `"${name}" changed on disk outside Skrive — your edits are kept here.`,
        'Overwrite',
        () => useProjectStore.getState().forceSaveLiveDoc(liveDoc.path)
      );
      return;
    }
    const writable: LiveDoc = {
      ...current,
      frontmatter: { ...current.frontmatter }
    };
    const payload = buildSavePayload(writable);
    const hash = await window.skrive.fs.writeFile(
      manifest.root,
      current.path,
      payload
    );
    void projectModel()?.upsert(
      current.path,
      modelSyncBody(current.mode, payload)
    );
    const after = get().liveDoc;
    if (!after || after.path !== current.path) return;
    const advanced =
      after.body !== current.body || after.model !== current.model;
    set({
      liveDoc: {
        ...after,
        frontmatter: writable.frontmatter,
        dirty: advanced,
        diskHash: hash
      }
    });
  },

  async forceSaveLiveDoc(path: string) {
    // Overwrite the on-disk file with the editor's version, resolving a
    // conflict. Invoked from the Overwrite prompt. If the writer switched
    // away since the conflict surfaced, the demote already flushed the doc
    // — nothing left to force.
    const { manifest, liveDoc } = get();
    if (!manifest || !liveDoc || liveDoc.path !== path) return;
    const writable: LiveDoc = {
      ...liveDoc,
      frontmatter: { ...liveDoc.frontmatter }
    };
    const payload = buildSavePayload(writable);
    const hash = await window.skrive.fs.writeFile(manifest.root, path, payload);
    void projectModel()?.upsert(path, modelSyncBody(liveDoc.mode, payload));
    const after = get().liveDoc;
    if (!after || after.path !== path) return;
    set({
      liveDoc: {
        ...after,
        body: writable.body,
        frontmatter: writable.frontmatter,
        dirty: false,
        conflict: false,
        diskHash: hash
      }
    });
  },

  // ============================ File CRUD ============================

  async createFile(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    const normalized = relPath.endsWith('.md') ? relPath : `${relPath}.md`;
    await window.skrive.fs.newFile(manifest.root, normalized);
    // Awaited: openDoc needs the new entry in the manifest, and the
    // client guarantees the model update lands before this resolves.
    await projectModel()?.upsert(normalized, '');
    await get().openDoc(normalized);
  },

  async createTextFile(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    const normalized = relPath.endsWith('.txt') ? relPath : `${relPath}.txt`;
    await window.skrive.fs.newFile(manifest.root, normalized);
    // Registers an openable non-Markdown entry (see ProjectModel.upsertOpenable);
    // awaited so openDoc finds it. Opens empty in plain-text mode.
    await projectModel()?.upsert(normalized, '');
    await get().openDoc(normalized);
  },

  async createFolioDocument(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    const normalized = relPath.endsWith('.folio') ? relPath : `${relPath}.folio`;
    // Mint identity once, here (folio schema §3). A fresh document opens on a
    // single empty paragraph — a caret-ready first line (it renders as a <br>
    // placeholder), like a new document in any rich editor. createdAt is
    // immutable and never re-stamped on save.
    const doc: FolioDocument = {
      schemaVersion: 1,
      docId: generateDocId(),
      docMeta: { title: null, createdAt: new Date().toISOString() },
      blocks: [{ id: generateBlockId(), type: 'paragraph', inline: [] }]
    };
    await writeFolioAndOpen(get, manifest.root, normalized, doc);
  },

  async exportDocument(path: string, format: ExportFormatId) {
    const { manifest } = get();
    if (!manifest) return;
    // Export is a `.folio`-only operation (the native format is the source of
    // truth we project out of). The UI only offers it on `.folio` files; this
    // guard makes that a contract, not a convention.
    if (fileMode(path) !== 'rich') return;
    const fmt = EXPORT_FORMATS.find((f) => f.id === format);
    if (!fmt) return;

    const displayName = stripFolioExtension(path.split('/').pop() ?? path);
    let target: string;
    try {
      const content = await window.skrive.fs.readFile(manifest.root, path);
      const folio = parseFolio(content.body);
      const bytes = exportFolio(folio, format, { title: displayName });
      // Uniquify against the live manifest so an export never clobbers a
      // same-named file. Exclusive-create then write mirrors the folio create
      // path; the watcher surfaces the new file in the sidebar.
      const existing = new Set(manifest.files.map((f) => f.path));
      target = exportTargetPath(path, fmt.extension, (p) => existing.has(p));
      await window.skrive.fs.newFile(manifest.root, target);
      await window.skrive.fs.writeFile(manifest.root, target, bytes);
    } catch (err) {
      logProjectError('exportDocument', err);
      notify.error(`Couldn't export ${displayName}`, err);
      return;
    }
    notify.success(`Exported ${target.split('/').pop()}`);
  },

  async pasteImageAsset(docPath: string, filename: string, bytes: Uint8Array) {
    const { manifest } = get();
    if (!manifest) throw new Error('pasteImageAsset: no active project');
    const target = imagePasteTarget(docPath, filename);
    await window.skrive.fs.writeBinaryFile(manifest.root, target.writePath, bytesToBase64(bytes));
    return target.linkPath;
  },

  async convertToFolio(path: string) {
    const { manifest } = get();
    if (!manifest) return;
    const kind = importKind(path);
    if (kind === null) return; // not a convertible source (or already `.folio`)

    const displayName = path.split('/').pop() ?? path;
    let target: string;
    try {
      const content = await window.skrive.fs.readFile(manifest.root, path);
      const { model, title } = sourceToModel(content.body, kind);
      // Mint a fresh identity — the source has none. createdAt stamped now; the
      // source's own frontmatter dates aren't a folio concept.
      const doc = modelToFolio(model, {
        docId: generateDocId(),
        docMeta: { title, createdAt: new Date().toISOString() }
      });
      // A new `.folio` beside the source (`notes.md` -> `notes.folio`), never
      // clobbering an existing file. The source keeps its own extension and is
      // left untouched — the upgrade never enriches in place (portability rule).
      const existing = new Set(manifest.files.map((f) => f.path));
      target = exportTargetPath(path, 'folio', (p) => existing.has(p));
      await writeFolioAndOpen(get, manifest.root, target, doc);
    } catch (err) {
      logProjectError('convertToFolio', err);
      notify.error(`Couldn't convert ${displayName}`, err);
      return;
    }
    notify.success(`Converted to ${stripFolioExtension(target.split('/').pop() ?? target)}`);
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
    // Drop the deleted file from the working set + trail right away (and
    // fall back off it if it was live). The watcher's unlink event will
    // also fire and sync the model, but pruning here keeps the chrome
    // responsive.
    pruneVanishedDocs(get, set, (p) => p !== relPath);
    const pins = get().pinned;
    if (pins.includes(relPath)) {
      set({ pinned: pins.filter((p) => p !== relPath) });
      scheduleImmediateSave(get);
    }
    await projectModel()?.remove(relPath);
  },

  async deleteDirectory(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    await window.skrive.fs.trash(manifest.root, relPath);
    // Drop every document inside the deleted directory.
    const prefix = relPath.endsWith('/') ? relPath : `${relPath}/`;
    pruneVanishedDocs(get, set, (p) => !p.startsWith(prefix));
    const pins = get().pinned;
    const prunedPins = pins.filter((p) => !p.startsWith(prefix));
    if (prunedPins.length !== pins.length) {
      set({ pinned: prunedPins });
      scheduleImmediateSave(get);
    }
    // Drop every manifest file under the deleted directory from the
    // model. The watcher's per-file unlink events echo this; both paths
    // are idempotent.
    const client = projectModel();
    if (client) {
      const doomed = manifest.files
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => f.path);
      for (const p of doomed) await client.remove(p);
    }
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

  togglePin(path: string) {
    const current = get().pinned;
    const next = current.includes(path)
      ? current.filter((p) => p !== path)
      : [...current, path];
    set({ pinned: next });
    scheduleImmediateSave(get);
  },

  setSortKey(key: SidebarSortKey) {
    if (get().sortKey === key) return;
    set({ sortKey: key });
    scheduleImmediateSave(get);
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

  openSettings(section) {
    // Force Settings open (not a toggle) and stage the deep-link. Setting
    // the section even when already on Settings lets an open pane jump to
    // the requested section; SettingsView clears it once consumed.
    set({ activeView: 'settings', settingsSection: section ?? null });
  },

  clearSettingsSection() {
    if (get().settingsSection !== null) set({ settingsSection: null });
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
    // Flush dirty state on the renamed doc first so an in-flight
    // edit doesn't get clobbered when the renderer reopens it under
    // the new path. Best-effort — a failed flush is noisier than a
    // failed rename and the user can retry.
    const renamed = get().liveDoc;
    if (renamed?.path === oldPath && renamed.dirty) {
      try {
        const writable: LiveDoc = {
          ...renamed,
          frontmatter: { ...renamed.frontmatter }
        };
        const payload = buildSavePayload(writable);
        await window.skrive.fs.writeFile(manifest.root, oldPath, payload);
        // The rename plan is computed from the worker's bodies — the
        // flushed content must be in the model before planning, or
        // the rewrite would resurrect the stale body.
        await projectModel()?.upsert(oldPath, payload);
      } catch (err) {
        logProjectError('flush before rename', err);
      }
    }
    // Worker computes the rewrites; the store applies them through
    // ordinary fs commands (plan order: writes first — self-references
    // land at the OLD path — then the rename), then feeds the results
    // back into the model.
    const client = projectModel();
    if (!client) return;
    const plan = await client.renamePlan(oldPath, newPath);
    for (const write of plan.writes) {
      await window.skrive.fs.writeFile(manifest.root, write.path, write.body);
    }
    await window.skrive.fs.rename(manifest.root, oldPath, newPath);
    for (const write of plan.writes) {
      if (write.path === oldPath) continue;
      await client.upsert(write.path, write.body);
    }
    await client.remove(oldPath);
    const renamedBody = await window.skrive.fs.readFile(manifest.root, newPath);
    await client.upsert(newPath, renamedBody.body, {
      modifiedMs: renamedBody.modifiedMs
    });
    // The watcher's add+unlink events refresh the manifest, but we also
    // need every path the chrome remembers to follow the rename: the live
    // doc (so the editor doesn't try to load the gone-away `oldPath`), its
    // working-set entry, and every trail visit.
    {
      const { liveDoc, workingSet, trail } = get();
      const patch: Partial<State> = {};
      if (liveDoc?.path === oldPath) {
        patch.liveDoc = { ...liveDoc, path: newPath };
      }
      if (workingSet.some((e) => e.path === oldPath)) {
        patch.workingSet = workingSet.map((e) =>
          e.path === oldPath ? { ...e, path: newPath } : e
        );
      }
      patch.trail = renameInTrail(trail, oldPath, newPath);
      set(patch);
    }
    // Repoint a pin at the renamed file so Favorites survives a rename.
    {
      const pins = get().pinned;
      const i = pins.indexOf(oldPath);
      if (i >= 0) {
        const repointed = pins.slice();
        repointed[i] = newPath;
        set({ pinned: repointed });
        scheduleImmediateSave(get);
      }
    }
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
    const doc = get().liveDoc;
    if (!doc) {
      set({ historyOfActive: [] });
      return;
    }
    try {
      const rows = await window.skrive.history.listForFile(doc.path);
      // Drop the result if the live doc changed mid-fetch.
      const after = get().liveDoc;
      if (!after || after.path !== doc.path) return;
      set({ historyOfActive: rows });
    } catch (err) {
      logProjectError('history:listForFile', err);
      set({ historyOfActive: [] });
    }
  },

  async setGitHistoryEnabled(enabled) {
    // Persist the preference, push it to the shell, and re-fetch the open
    // project's history under the now-effective backend. The shell returns
    // the effective mode (checkpoint when disabled, regardless of `.git/`).
    usePreferencesStore.getState().setGitHistoryEnabled(enabled);
    try {
      const mode = await window.skrive.history.setGitHistoryEnabled(enabled);
      set({ historyMode: mode });
    } catch (err) {
      logProjectError('history:setGitHistoryEnabled', err);
    }
    await get().refreshHistory();
  },

  async openDiffForEntry(entry, baseline) {
    const doc = get().liveDoc;
    if (!doc) return;
    // The diff pane mirrors how the document is being viewed: a raw-text
    // diff when Markdown source is on screen (source or split layout), a
    // rendered diff otherwise (preview layout, or a rich `.folio` doc).
    const showingSource =
      doc.mode === 'markdown' && doc.layoutMode !== 'preview';
    const diffMode: 'diff-raw' | 'diff-preview' = showingSource
      ? 'diff-raw'
      : 'diff-preview';
    try {
      const beforeEntry: HistoryEntry = baseline ?? entry;
      const afterEntry: HistoryEntry | null = baseline ? entry : null;
      const [first, second] = await Promise.all([
        resolveDiffSide(doc.path, beforeEntry),
        afterEntry ? resolveDiffSide(doc.path, afterEntry) : resolveCurrentSide(doc)
      ]);
      const [left, right] =
        first.timestampMs <= second.timestampMs
          ? [first, second]
          : [second, first];
      const rows = await computeLineDiff(left.content, right.content);
      // Re-check the live doc in case it changed mid-fetch.
      const current = get().liveDoc;
      if (!current || current.path !== doc.path) return;
      set({
        liveDoc: {
          ...current,
          diff: {
            before: left,
            after: right,
            rows,
            dividerRatio: 0.5,
            diffMode
          }
        },
        historyPairBaseId: null,
        historyPanelOpen: false
      });
    } catch (err) {
      logProjectError('openDiffForEntry', err);
    }
  },

  closeDiff() {
    const doc = get().liveDoc;
    if (!doc || !doc.diff) return;
    set({ liveDoc: { ...doc, diff: null } });
  },

  setDiffMode(mode) {
    const doc = get().liveDoc;
    if (!doc || !doc.diff || doc.diff.diffMode === mode) return;
    set({ liveDoc: { ...doc, diff: { ...doc.diff, diffMode: mode } } });
  },

  setDiffDividerRatio(ratio) {
    const doc = get().liveDoc;
    if (!doc || !doc.diff) return;
    const clamped = clampRatio(ratio);
    if (doc.diff.dividerRatio === clamped) return;
    set({ liveDoc: { ...doc, diff: { ...doc.diff, dividerRatio: clamped } } });
  },

  async createManualCheckpoint(name) {
    const { manifest, liveDoc } = get();
    if (!manifest || !liveDoc) return;
    if (get().historyMode !== 'checkpoint') return;
    const writable: LiveDoc = {
      ...liveDoc,
      frontmatter: { ...liveDoc.frontmatter }
    };
    const payload = buildSavePayload(writable);
    await window.skrive.history.createManualCheckpoint(
      liveDoc.path,
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
      const modelClient = projectModel();
      const [deadLinks, orphanedFiles] = modelClient
        ? await Promise.all([
            modelClient.getDeadLinks(),
            modelClient.getOrphanedFiles()
          ])
        : [[], []];
      logDuration('lint model (deadlinks+orphans)', ipcStart);
      // Seed the body map with the live doc so unsaved edits are linted
      // against the editor content, not the on-disk version. Every other
      // file reads from the closed-body cache / disk below — demoted
      // documents were flushed on switch, so disk is current for them.
      const bodies = new Map<string, string>();
      const live = get().liveDoc;
      if (live) bodies.set(live.path, live.body);
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
        // stable because applyModelUpdate only swaps a new manifest in on a real
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

  updateLiveDocFrontmatter(key: string, value: unknown) {
    const doc = get().liveDoc;
    if (!doc) return;
    const next = { ...doc.frontmatter };
    next[key] = value;
    set({ liveDoc: { ...doc, frontmatter: next, dirty: true } });
  },

  removeLiveDocFrontmatter(key: string) {
    const doc = get().liveDoc;
    if (!doc || !(key in doc.frontmatter)) return;
    const next = { ...doc.frontmatter };
    delete next[key];
    set({ liveDoc: { ...doc, frontmatter: next, dirty: true } });
  },

  renameLiveDocFrontmatterKey(oldKey: string, newKey: string) {
    const doc = get().liveDoc;
    if (!doc) return;
    if (oldKey === newKey) return;
    if (!(oldKey in doc.frontmatter)) return;
    if (newKey in doc.frontmatter) return; // Conflict — silently no-op.
    // Rebuild the map preserving original key order, swapping oldKey→newKey
    // in place so the panel rows don't reorder unexpectedly.
    const next: FrontmatterMap = {};
    for (const [k, v] of Object.entries(doc.frontmatter)) {
      if (k === oldKey) next[newKey] = v;
      else next[k] = v;
    }
    set({ liveDoc: { ...doc, frontmatter: next, dirty: true } });
  }
}));

// ============================ Selectors ============================
//
// Stable selectors for components that only need derived state. Using
// these keeps re-renders tight — a live-doc body change shouldn't
// re-render the sidebar, etc.

export const selectLiveDoc = (s: State): LiveDoc | null => s.liveDoc;

export const selectLiveDocPath = (s: State): string | null =>
  s.liveDoc?.path ?? null;

// ============================ Error logging ============================

export function logProjectError(label: string, err: unknown) {
  console.error(`[skrive project] ${label}`, err);
}
