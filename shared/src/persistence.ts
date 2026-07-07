// UI-state persistence types — the on-disk shapes for `app.json` and
// `projects/{hash}.json`. Mirrors `src-tauri/src/persistence.rs` so a
// v0.1.6-written state file loads cleanly under v0.2 and vice versa.
//
// Three-tier model (per `planning/open-questions.md` A3):
//   - `.skrive.toml` — shared, project-scoped (Phase 8).
//   - `{userData}/projects/{hash}.json` — per-project UI state.
//   - `{userData}/app.json` — app-wide UI state.
//
// Save strategy is owned by the renderer:
//   - Immediate: open/close/reorder, layout-mode, sidebar visibility,
//     settings mutations.
//   - Debounced 1s: scroll, sidebar width drag, split-divider drag.
//   - Blur/quit: cursor position (per-keystroke saves are wasteful).

/** LEGACY (pre-SKR-111 cutover). The raw/split/preview surfaces were retired
 *  when the bespoke block surface became the only editor; the renderer no longer
 *  reads `TabState.layoutMode`. Kept so older state files (and the Zig-core
 *  persistence mirror) still load without a schema bump — the value round-trips. */
export type LayoutMode = 'raw' | 'split' | 'preview';

export type CursorPosition = {
  /** 1-indexed for display, matches CodeMirror's selection.head line. */
  line: number;
  /** 0-indexed UTF-16 column in `line`. */
  column: number;
};

export type TabState = {
  path: string;
  layoutMode: LayoutMode;
  cursor: CursorPosition;
  scrollTop: number;
  splitDividerRatio: number;
};

/** How the "All" file tree is ordered. 'created' needs a birthtime from
 *  the native scanner (Zig core); the other two derive from data the
 *  manifest already carries. */
export type SidebarSortKey = 'name' | 'modified' | 'created';

export type SidebarState = {
  visible: boolean;
  width: number;
  /** Project-relative file paths pinned to the Favorites zone at the top
   *  of the sidebar, in pin order. Optional for back-compat with state
   *  files written before pins existed; absent reads as empty. */
  pinned?: string[];
  /** File-tree ordering. Optional for back-compat; absent reads as 'name'. */
  sortKey?: SidebarSortKey;
};

export type ProjectUiState = {
  schemaVersion: 1;
  projectPath: string;
  projectName: string;
  /** Unix milliseconds. Set at save time. */
  lastOpenedMs: number;
  sidebar: SidebarState;
  tabs: TabState[];
  activeTabIndex: number;
};

export type RecentProject = {
  path: string;
  name: string;
  lastOpenedMs: number;
};

export type RecentFile = {
  /** Canonical project root path. Matches `ProjectManifest.root`. */
  projectPath: string;
  /** Project-relative file path, forward-slash separated. */
  filePath: string;
  openedMs: number;
};

export type EditorFontId =
  | 'editorial'
  | 'classic'
  | 'screen'
  | 'sans'
  | 'mono'
  | 'custom';

/** Color theme. 'system' follows the OS via prefers-color-scheme;
 *  'light' (the clean white duotone) / 'dark' override. Default for new
 *  installs is 'light'; legacy users without a stored theme migrate to
 *  'dark' (the only theme that existed before v0.2.2) so they don't get
 *  whiplash. The former warm light palette and the separate cool 'white'
 *  theme were consolidated into a single 'light'. (Overcast is the design
 *  aesthetic, not a color option — it persists across all schemes.) */
export type ThemeId = 'system' | 'light' | 'dark';

/** LEGACY (pre-SKR-111 cutover). Selected the Rich (ProseMirror) vs Text
 *  (CodeMirror) surface; both engines were retired when the bespoke block
 *  surface became the only editor. Retained for schema stability — see
 *  LayoutMode. The renderer no longer reads `AppUiState.defaultSurface`. */
export type SurfaceId = 'text' | 'rich';

/** LEGACY (pre-SKR-111 cutover). Controlled how the retired Text (CodeMirror)
 *  surface dimmed Markdown syntax markers. Retained for schema stability — the
 *  renderer no longer reads `AppUiState.markerMode`. */
export type MarkerMode = 'raw' | 'recessed' | 'concealed';

/** Width of the centered writing column. A reading-comfort knob; the
 *  exact measures are resolved at the editor surface (Stage 2 wiring). */
export type LineMeasure = 'narrow' | 'normal' | 'wide';

/** The figure the word-count chip displays (SKR-53). */
export type WordCountMetric = 'words' | 'time' | 'chars';

/** Where the "new file" action drops a document.
 *   - 'activeFolder' — alongside the doc you're in (project root if none open).
 *   - 'projectRoot'  — always the project root. */
export type NewFileLocation = 'activeFolder' | 'projectRoot';

/** How a new file's name is derived.
 *   - 'title'    — slugified from the document title as you write it.
 *   - 'untitled' — a plain "Untitled" placeholder you rename yourself. */
export type NewFileNaming = 'title' | 'untitled';

/** Slug casing for heading anchors and wiki links. */
export type SlugFormat = 'kebab-case' | 'snake_case';

export type AppUiState = {
  schemaVersion: 1;
  lastOpenedProject: string | null;
  recentProjects: RecentProject[];
  /** License key (post-Phase 9 UI). Field shipped now so the on-disk
   *  shape stays stable across the eventual license-entry surface. */
  license: string | null;
  /** Unix milliseconds; set the first time the app boots. */
  firstRunMs: number | null;
  /** Number of times the app has booted. Bumped once per `hydrate()`.
   *  Drives the one-time feedback nudge (shown once `launchCount`
   *  crosses a threshold). */
  launchCount: number;
  /** Set true the moment the one-time feedback toast is shown, so it
   *  never reappears. Independent of whether the writer acted on it. */
  seenFeedbackPrompt: boolean;
  personalDictionary: string[];
  skipDeleteConfirmation: boolean;
  /** Filled by Phase 11 (command palette). Empty in Phase 9. */
  recentFiles: RecentFile[];
  editorFont: EditorFontId;
  editorCustomFontFamily: string;
  editorFontSize: number;
  /** Line height ×100 (170 → 1.7). Fixed-point so the JSON is
   *  integer-valued and round-trips don't drift on common values. */
  editorLineHeightX100: number;
  autoUpdateOnLaunch: boolean;
  theme: ThemeId;
  /** Show the outline rail down the right edge of the preview. */
  showOutlineRail: boolean;
  /** Show the live word/character/reading-time counter in the editor's
   *  bottom-left corner (SKR-53). */
  showWordCount: boolean;
  /** Which figure the counter chip displays (switched via its chevron). */
  wordCountMetric: WordCountMetric;
  /** Which editing surface new tabs open in. */
  defaultSurface: SurfaceId;
  /** Whether the writer may switch surfaces (⌘⇧E / the palette command).
   *  When false the surface is locked to `defaultSurface` — the escape hatch
   *  for a never-seen-Markdown writer who should never be one keystroke from
   *  raw syntax, and for anyone who wants a single, stable editing model. */
  surfaceSwitchingEnabled: boolean;
  /** How the Text surface renders Markdown markers (raw / recessed / concealed). */
  markerMode: MarkerMode;

  // ---- Skrive 1.0 settings (Stage 1). Persisted now; several wire to
  //      live behavior incrementally (Stage 2+). Each is a plain pref the
  //      Settings page reads and writes; unwired ones still round-trip. ----

  /** Width of the centered writing column. */
  lineMeasure: LineMeasure;
  /** Curly quotes, em dashes, and ellipses substituted as you type. */
  smartTypography: boolean;
  /** Normalize Markdown spacing when a file is written to disk. */
  formatOnSave: boolean;
  /** Debounce (ms) between the last keystroke and an autosave flush. */
  autosaveIdleDelayMs: number;
  /** Where the "new file" action creates the document. */
  newFileLocation: NewFileLocation;
  /** How a new file's name is derived. */
  newFileNaming: NewFileNaming;
  /** Slug casing for heading anchors and wiki links. */
  slugFormat: SlugFormat;
  /** Use the project's git repository for version history when one is
   *  present. When false, Skrive ignores `.git` and keeps its own
   *  checkpoint history for every project instead — git is never read or
   *  queried. Global, not per-project. */
  gitHistoryEnabled: boolean;
  /** Seed new documents with a frontmatter block. */
  seedFrontmatter: boolean;
  /** Frontmatter keys inserted into every seeded document, in order. */
  frontmatterFields: string[];
  /** strftime-ish token string for the seeded `date` field. */
  dateFormat: string;
};

export const DEFAULT_RECENT_PROJECTS_CAP = 10;

export const DEFAULT_APP_UI_STATE: AppUiState = {
  schemaVersion: 1,
  lastOpenedProject: null,
  recentProjects: [],
  license: null,
  firstRunMs: null,
  launchCount: 0,
  seenFeedbackPrompt: false,
  personalDictionary: [],
  skipDeleteConfirmation: false,
  recentFiles: [],
  editorFont: 'editorial',
  editorCustomFontFamily: '',
  editorFontSize: 17,
  editorLineHeightX100: 150,
  autoUpdateOnLaunch: true,
  theme: 'light',
  showOutlineRail: true,
  showWordCount: true,
  wordCountMetric: 'words',
  defaultSurface: 'rich',
  surfaceSwitchingEnabled: true,
  markerMode: 'recessed',
  lineMeasure: 'normal',
  smartTypography: true,
  formatOnSave: false,
  autosaveIdleDelayMs: 500,
  newFileLocation: 'activeFolder',
  newFileNaming: 'title',
  slugFormat: 'kebab-case',
  gitHistoryEnabled: true,
  seedFrontmatter: true,
  frontmatterFields: ['title', 'date', 'tags'],
  dateFormat: 'YYYY-MM-DD'
};

export const DEFAULT_SIDEBAR_WIDTH = 260;
export const DEFAULT_SPLIT_DIVIDER_RATIO = 0.5;

export function defaultProjectUiState(
  projectPath: string,
  projectName: string
): ProjectUiState {
  return {
    schemaVersion: 1,
    projectPath,
    projectName,
    lastOpenedMs: Date.now(),
    sidebar: {
      visible: true,
      width: DEFAULT_SIDEBAR_WIDTH,
      pinned: [],
      sortKey: 'name'
    },
    tabs: [],
    activeTabIndex: -1
  };
}
