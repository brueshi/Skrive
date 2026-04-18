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

export type LayoutMode = "raw" | "split" | "preview";

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
};

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
  /** 0-indexed character offset into `snippet` where the match begins. */
  column: number;
  /** Character length of the match (equals the query for case-sensitive). */
  matchLength: number;
  /** Full line content that contains the match. */
  snippet: string;
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
