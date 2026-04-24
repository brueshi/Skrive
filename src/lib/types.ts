// Frontend mirrors of the Rust-side types returned by the Tauri commands.
// Kept in sync by hand for Phase 1/2. Once the surface stabilizes, we can
// generate these from the Rust source (specta, ts-rs) — but hand-written is
// fine for now and keeps the dependency footprint small.

export type ProjectManifest = {
  root: string;
  files: FileEntry[];
  schema: ProjectSchema;
};

// Project-wide frontmatter schema, inferred by the Rust core during
// `open_project`. Mirrors `src-tauri/src/project.rs::ProjectSchema`.
// The frontend caches this on the project store so the frontmatter
// panel and autocomplete layer read from memory rather than hitting
// Rust on every keystroke.
export type ProjectSchema = {
  fileCount: number;
  fields: Record<string, FieldInfo>;
};

export type FieldInfo = {
  /** Number of files in the project that contain this field at all. */
  presence: number;
  /** Distinct value types seen across files, sorted alphabetically. */
  types: string[];
  /**
   * Distinct scalar values seen across files, in insertion order.
   * Populated only for fields whose values are all scalars (string,
   * number, boolean, null) *and* whose distinct count is ≤ 20. Empty
   * for large value sets and for any field that ever saw an array or
   * object value. An empty array means "no suggestions to offer".
   */
  knownValues: unknown[];
};

export type FileEntry = {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number | null;
  frontmatter: Record<string, unknown>;
  outgoingLinks: string[];
};

export type FileContent = {
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  modifiedMs: number | null;
};

// Frontend-only. Owned by the project store; never travels over the IPC wire.
export type Tab = {
  path: string;
  content: FileContent;
  dirty: boolean;
  layoutMode: LayoutMode;
  splitDividerRatio: number;
  /**
   * A one-shot request for the editor to position its selection at a
   * specific line/column after mount. Set by `openTabAtLine` when search
   * results are clicked, then left in place — the editor honors the
   * `nonce` each time it changes, which lets repeated jumps to the same
   * location still fire.
   */
  pendingSelection: PendingSelection | null;
  /**
   * Diff-mode state for this tab. `null` when the tab is in any non-
   * diff layout mode. Populated by the history panel's row-click flow
   * (`project.openDiffForEntry`) and cleared on `project.exitDiffMode`.
   * Session-only — never persisted to `TabState` because diff is a
   * transient viewing mode, not a saved layout preference.
   */
  diff: DiffState | null;
};

export type PendingSelection = {
  /** 1-indexed line (what CodeMirror and humans want). */
  line: number;
  /** 0-indexed character column into the line. */
  column: number;
  /** Characters to select starting at column. 0 places a cursor. */
  length: number;
  /**
   * Monotonic stamp that changes on every jump. Consumers subscribe
   * to this so repeated jumps to the same line still fire.
   */
  nonce: number;
};

/**
 * Layout mode for a tab. `"raw"` / `"split"` / `"preview"` are the
 * three editor modes; `"diff-raw"` / `"diff-preview"` are the diff
 * viewer's two modes, mutually exclusive with `split` because both
 * compete for the same two-pane surface (see
 * `docs/3.3-diff-ui-design.md`). Diff variants live in runtime state
 * only — `TabState` persists the three editor modes, and diff mode
 * evaporates on project close or app restart.
 */
export type LayoutMode =
  | "raw"
  | "split"
  | "preview"
  | "diff-raw"
  | "diff-preview";

/**
 * One pane's worth of diff content. `label` is the primary identifier
 * shown in the pane header (commit subject, manual pin name, `"auto"`,
 * or `"Current"`); the component composes that with a humanized
 * `timestampMs` for the full "Before — 2 days ago" rendering.
 * `source` is a discriminator for any source-specific styling the
 * diff renderer wants to apply later.
 */
export type DiffSide = {
  content: string;
  timestampMs: number;
  label: string;
  source: "git" | "checkpoint" | "current";
};

/**
 * Session-only diff state hanging off a `Tab`. `restoreMode` is the
 * layout mode the tab was in when diff was entered — the close button
 * and the Escape key both route through it to undo the transition
 * cleanly. `dividerRatio` is independent of `splitDividerRatio`: a
 * user may prefer 50/50 for diffs and 60/40 for editor splits. `rows`
 * is the precomputed side-by-side diff; lives on state so the
 * renderer doesn't have to re-diff on every rerender.
 */
export type DiffState = {
  before: DiffSide;
  after: DiffSide;
  dividerRatio: number;
  restoreMode: "raw" | "preview";
  rows: import("$lib/diff/line-diff").LineDiffRow[];
};

/**
 * Which history source drives the version-history panel for the active
 * project. Mirrors `src-tauri/src/project.rs::HistoryMode`. Decided once
 * at `open_project` and read back by the frontend via `get_history_mode`
 * to route history-panel queries through git or through Skrive's
 * checkpoint store. See `docs/checkpoint-storage.md` for the storage
 * contract when this is `"checkpoints"`.
 */
export type HistoryMode = "git" | "checkpoints";

/**
 * One commit that touched the file whose history the panel is showing.
 * Mirrors `src-tauri/src/history.rs::GitVersion`. Returned by the
 * `get_git_history` command, newest-first. The history panel renders
 * each row with `shortSha` + a humanized `timestampMs` + `subject`;
 * clicking a row routes `sha` + the active file path to
 * `read_git_version` to populate one pane of the diff view.
 */
export type GitVersion = {
  /** Full hexadecimal commit sha. */
  sha: string;
  /** First 8 characters of `sha`, pre-sliced for compact display. */
  shortSha: string;
  /** Parent commit sha. `null` for the initial commit. */
  parentSha: string | null;
  authorName: string;
  authorEmail: string;
  /** Commit time in Unix milliseconds, same units as `modifiedMs`. */
  timestampMs: number;
  /** First line of the commit message. */
  subject: string;
  /**
   * Commit message minus the subject and the blank line that follows
   * it. Empty string when the message is a subject-only one-liner.
   */
  body: string;
};

/**
 * Which trigger wrote a checkpoint — the autosave path (`"auto"`) or
 * an explicit user action (`"manual"`). Mirrors
 * `src-tauri/src/history.rs::CheckpointKind`.
 */
export type CheckpointKind = "auto" | "manual";

/**
 * One checkpoint on disk for the file whose history the panel is
 * showing. Mirrors `src-tauri/src/history.rs::CheckpointVersion`.
 * Returned by `get_checkpoint_history`, newest-first. `id` is the
 * opaque key to pass back to `read_checkpoint_version` when the user
 * picks a row. `name` is the user-typed pin name for manual
 * checkpoints; `null` for auto and for sidecar-less manuals.
 */
export type CheckpointVersion = {
  id: string;
  timestampMs: number;
  kind: CheckpointKind;
  name: string | null;
  /**
   * Hex-encoded SHA-256 of the checkpoint's bytes. Drives the writer's
   * dedup check; the UI can use it to collapse visible duplicates.
   */
  contentHash: string;
};

/**
 * Unified row shape the history panel feeds to the diff view. A
 * discriminated union over `source` so the UI renders both git
 * commits and checkpoints with one pass of template code while
 * keeping the per-source data intact. Built on the frontend from
 * either `get_git_history` or `get_checkpoint_history` output — not
 * sent over the IPC wire, so a stale mode doesn't poison the list.
 */
export type HistoryEntry =
  | ({ source: "git" } & GitVersion)
  | ({ source: "checkpoint" } & CheckpointVersion);

// =========================== Persistence types ===========================
// These mirror the Rust `persistence::ProjectUiState` / `AppUiState` shapes.
// Serialized by the Rust core to `{app_data_dir}/projects/{hash}.json` and
// `{app_data_dir}/app.json` respectively. The three-tier state model is
// documented in `docs/open-questions.md` A3 (Resolved).

export type ProjectUiState = {
  schemaVersion: number;
  projectPath: string;
  projectName: string;
  /** Unix milliseconds. */
  lastOpenedMs: number;
  sidebar: SidebarState;
  tabs: TabState[];
  activeTabIndex: number;
};

export type SidebarState = {
  visible: boolean;
  width: number;
};

export type TabState = {
  path: string;
  layoutMode: "raw" | "split" | "preview";
  cursor: CursorPosition;
  scrollTop: number;
  splitDividerRatio: number;
};

export type CursorPosition = {
  line: number;
  column: number;
};

export type AppUiState = {
  schemaVersion: number;
  lastOpenedProject: string | null;
  recentProjects: RecentProject[];
  license: string | null;
  firstRunMs: number | null;
  /**
   * Skrive-managed personal dictionary. Words on this list get
   * `spellcheck="false"` decorations on every occurrence in any open
   * file, additive to the OS spellchecker's own personal dictionary.
   */
  personalDictionary: string[];
  /**
   * When true, the sidebar's delete flow skips the confirmation modal
   * and trashes the target immediately. Flipped by the "Don't ask again"
   * checkbox in the delete modal.
   */
  skipDeleteConfirmation: boolean;
  /**
   * Flat LRU of recently opened files across projects. The command
   * palette filters to the currently open project and renders the top
   * matches as the empty-query default.
   */
  recentFiles: RecentFile[];
  /**
   * Editor font preset id. The frontend maps this to a concrete CSS
   * font-family stack — the wire format keeps the id stable across
   * stack tweaks. Defaults to "editorial".
   */
  editorFont: EditorFontId;
  /**
   * Free-form family name used when `editorFont === "custom"`. Empty
   * string = no override (CSS falls through to the default stack).
   */
  editorCustomFontFamily: string;
  /** Editor font size in pixels. Defaults to 17. */
  editorFontSize: number;
  /**
   * Editor line height as a unitless multiplier × 100. Persisted as
   * an integer so JSON round-trips don't drift on common values like
   * 1.7 (stored as 170). Defaults to 170.
   */
  editorLineHeightX100: number;
  /**
   * When true (default), Skrive silently checks for updates on launch.
   * Toggled from the Updates section in Settings.
   */
  autoUpdateOnLaunch: boolean;
};

export type EditorFontId =
  | "editorial"
  | "classic"
  | "screen"
  | "sans"
  | "mono"
  | "custom";

export type RecentFile = {
  /** Canonical project root path. Matches `ProjectManifest.root`. */
  projectPath: string;
  /** Project-relative file path. Forward-slash separated. */
  filePath: string;
  openedMs: number;
};

// =========================== Search types ===========================
// Mirror `src-tauri/src/project.rs::{SearchOptions, SearchHit}`.

export type SearchOptions = {
  caseSensitive: boolean;
};

export type SearchHit = {
  /** Project-relative file path, forward-slash separated. */
  path: string;
  /** 1-indexed line number, what CodeMirror wants. */
  lineNumber: number;
  /**
   * 0-indexed UTF-16 code-unit offset into `snippet` where the match
   * begins. Same convention as backlinks / outgoing links, so `String#slice`
   * and CodeMirror positions consume it directly.
   */
  column: number;
  /** Length of the match in UTF-16 code units. */
  matchLength: number;
  /** Full line content that contains the match. */
  snippet: string;
};

// =========================== Link graph types ===========================
// Mirror `src-tauri/src/project.rs::{Backlink, OutgoingLink}`. Same shape,
// different semantics for `path`: in `Backlink` it's the source that
// links to the queried file; in `OutgoingLink` it's the target the
// queried file points at.

export type Backlink = {
  /** Project-relative path of the file that links here. */
  path: string;
  /** 1-indexed line number of the link inside `path`. */
  line: number;
  /** 0-indexed UTF-16 column of the link's start inside the source line. */
  column: number;
  /** Trimmed source line containing the reference, truncated to a readable width. */
  snippet: string;
};

export type OutgoingLink = {
  /** Project-relative path of the file being linked to. */
  path: string;
  /** 1-indexed line number of the link inside the source. */
  line: number;
  /** 0-indexed UTF-16 column of the link's start inside the source line. */
  column: number;
  /** Trimmed source line containing the reference, truncated to a readable width. */
  snippet: string;
};

/**
 * Shape of one row in the Phase 3.4 lint engine's dead-link surface.
 * Mirrors `src-tauri/src/project.rs::DeadLink`. Produced by the
 * `get_dead_links` command; the Phase 3.4 UI is the only real consumer.
 */
export type DeadLink = {
  /** Project-relative path of the source file that contains the dead link. */
  sourcePath: string;
  /**
   * Unresolved target as the link wrote it — `"[[Other Note]]"` for
   * wiki-flavored dead links, the project-relative path for inline and
   * reference-style dead links. Lets the lint row render the original
   * form without reconstruction.
   */
  target: string;
  /** 1-indexed line number inside the source. */
  line: number;
  /** 0-indexed UTF-16 column inside the source line. */
  column: number;
  /** Trimmed source line, truncated to a readable width. */
  snippet: string;
  /** Which markdown construct produced the link. */
  kind: LinkKind;
};

/** Mirror of `src-tauri/src/link_graph.rs::LinkKind`. */
export type LinkKind =
  | "inline"
  | "wiki"
  | "referenceUse"
  | "referenceDefinition";

/**
 * One reference to the file being renamed. Used in both arrays on
 * `RenamePreview`. Mirrors `src-tauri/src/project.rs::Reference`.
 */
export type Reference = {
  /** Project-relative path of the file that contains the reference. */
  path: string;
  /** 1-indexed line number. */
  line: number;
  /** 0-indexed UTF-16 column inside the source line. */
  column: number;
  /** Trimmed source line, truncated to a readable width. */
  snippet: string;
  /** Which markdown construct holds the reference. */
  kind: LinkKind;
};

/**
 * Report returned by `rename_with_references` after a successful commit.
 * Mirrors `src-tauri/src/project.rs::RenameReport`. Consumed by the
 * store's `renameFile` method to know which tabs need a content refresh
 * and which paths to stamp as recent self-writes.
 */
export type RenameReport = {
  /** Project-relative paths whose contents were rewritten on disk. */
  filesWritten: string[];
  /** Total number of individual references replaced across all sources. */
  referencesUpdated: number;
};

/**
 * Response from the `preview_rename` command. Mirrors
 * `src-tauri/src/project.rs::RenamePreview`.
 */
export type RenamePreview = {
  /**
   * True when the proposed new path already exists in the project, or
   * when the user typed the same name back. Disables the Rename button.
   */
  targetExists: boolean;
  /** Edges from files OTHER than the one being renamed. */
  references: Reference[];
  /**
   * Self-references inside the renamed file. Rewritten as part of the
   * same operation, shown separately so the "N references across M
   * files" count stays cross-file-accurate.
   */
  definitionUpdates: Reference[];
};

// =========================== Open-with-Skrive ===========================

/**
 * Request emitted (and queued at startup) when the OS asks Skrive to open
 * a file — Finder double-click, `open -a Skrive x.md`, Explorer
 * double-click, `skrive file.md` on the CLI. Mirrors
 * `src-tauri/src/commands.rs::OpenFileRequest`.
 */
export type OpenFileRequest = {
  /** Canonical project root path, suitable for passing to openProject. */
  projectRoot: string;
  /** Project-relative file path. Forward-slash separated. */
  filePath: string;
};

export type RecentProject = {
  path: string;
  name: string;
  lastOpenedMs: number;
};
