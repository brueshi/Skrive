// Frontend mirrors of the Rust-side types returned by the Tauri commands.
// Kept in sync by hand for Phase 1/2. Once the surface stabilizes, we can
// generate these from the Rust source (specta, ts-rs) — but hand-written is
// fine for now and keeps the dependency footprint small.

export type ProjectManifest = {
  root: string;
  files: FileEntry[];
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
};

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
};

export type RecentProject = {
  path: string;
  name: string;
  lastOpenedMs: number;
};
