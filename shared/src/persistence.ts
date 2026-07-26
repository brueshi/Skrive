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

/** One remembered document in the working set (schemaVersion 2): the path
 *  plus the cheap view state a document keeps while it is off-screen. Entry 0
 *  is always the live document. Same per-entry fields as the schemaVersion-1
 *  TabState — the migration is a reorder + truncate, never a reshape. */
export type WorkingSetEntryState = {
  path: string;
  layoutMode: LayoutMode;
  cursor: CursorPosition;
  scrollTop: number;
  splitDividerRatio: number;
};

/** LEGACY (schemaVersion 1). Kept so v1 state files still parse; see
 *  `ProjectUiStateV1` and `migrateProjectUiState`. */
export type TabState = WorkingSetEntryState;

/** How the "All" file tree is ordered. 'created' needs a birthtime from
 *  the native scanner (Zig core); the other two derive from data the
 *  manifest already carries. */
export type SidebarSortKey = 'name' | 'modified' | 'created';

/** An active scope on the "All" document list. One facet at a time: a folder
 *  (`value` is a project-relative folder path) or a tag (`value` is the tag name,
 *  e.g. `todo` or `project/q3`). */
export type SidebarFilter = { kind: 'folder'; value: string } | { kind: 'tag'; value: string };

export type SidebarState = {
  visible: boolean;
  width: number;
  /** Project-relative file paths pinned to the Favorites zone at the top
   *  of the sidebar, in pin order. Optional for back-compat with state
   *  files written before pins existed; absent reads as empty. */
  pinned?: string[];
  /** File-tree ordering. Optional for back-compat; absent reads as 'name'. */
  sortKey?: SidebarSortKey;
  /** Active scope on the All list (SKR-245). One facet at a time. Optional
   *  for back-compat; absent reads as unscoped. */
  activeFilter?: SidebarFilter;
  /** How the All list is presented: a flat sorted list, or a browsable
   *  folder shelf-tree (SKR-245). Optional for back-compat; absent reads as
   *  'flat'. */
  allView?: SidebarAllView;
};

/** All-list presentation: the flat sorted list, or the folder shelf-tree. */
export type SidebarAllView = 'flat' | 'tree';

export type ProjectUiState = {
  schemaVersion: 2;
  projectPath: string;
  projectName: string;
  /** Unix milliseconds. Set at save time. */
  lastOpenedMs: number;
  sidebar: SidebarState;
  /** Bounded LRU of recently open documents, most recent first. Entry 0 is
   *  the live document (SKR-243: tabs retired for the working-set model). */
  workingSet: WorkingSetEntryState[];
};

/** LEGACY on-disk shape (schemaVersion 1, the tabs era). Never written
 *  anymore; loaded state files in this shape pass through
 *  `migrateProjectUiState` before the renderer reads them. */
export type ProjectUiStateV1 = {
  schemaVersion: 1;
  projectPath: string;
  projectName: string;
  lastOpenedMs: number;
  sidebar: SidebarState;
  tabs: TabState[];
  activeTabIndex: number;
};

/** Cap on the unpinned portion of the working set (SKR-243; adjustable
 *  during the dogfood). Pinned documents never evict and don't count. */
export const WORKING_SET_CAP = 8;

/** Bring a loaded project-state file up to schemaVersion 2. The shells store
 *  and return the file opaquely (the Zig core does no schema work on project
 *  state), so migration lives here, at the single point every load funnels
 *  through. v1 → v2: the active tab becomes entry 0, the rest keep their
 *  order, truncated to the cap. Unrecognizable input degrades to null (the
 *  same posture as a missing file). */
export function migrateProjectUiState(
  raw: ProjectUiState | ProjectUiStateV1 | null
): ProjectUiState | null {
  if (raw == null || typeof raw !== 'object') return null;
  if (raw.schemaVersion === 2) {
    return Array.isArray(raw.workingSet) ? raw : null;
  }
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.tabs)) return null;
  const { tabs, activeTabIndex, ...restV1 } = raw;
  const active = tabs[activeTabIndex];
  const workingSet = (
    active ? [active, ...tabs.filter((_, i) => i !== activeTabIndex)] : tabs
  ).slice(0, WORKING_SET_CAP);
  return { ...restV1, schemaVersion: 2, workingSet };
}

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

/** The selected reading face. The first group is bundled with the app (see
 *  app/src/lib/typography-registry.ts); the second resolves to a system font
 *  stack, which is the only way to offer faces we cannot redistribute, such
 *  as Palatino. 'custom' takes an arbitrary family from
 *  `editorCustomFontFamily`. Unknown values fall back to the default, so a
 *  face retired in a later version degrades rather than breaking the editor. */
export type EditorFontId =
  // Bundled, openly licensed.
  | 'literata'
  | 'newsreader'
  | 'source-serif-4'
  | 'eb-garamond'
  | 'alegreya'
  | 'inter'
  | 'source-sans-3'
  | 'atkinson-hyperlegible'
  | 'jetbrains-mono'
  | 'monaspace-neon'
  // System stacks.
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

/** Width of the centered writing column. A reading-comfort knob expressed
 *  in ch of the editor face (resolved to px in typography-css so every
 *  view shares one physical column); 'full' lifts the cap entirely. */
export type LineMeasure = 'narrow' | 'normal' | 'wide' | 'full';

/** What the global measure pref stores: a preset, or 'custom' backed by
 *  `lineMeasureCustomCh`. Per-document overrides stay preset-only — a doc
 *  pointing at the app-global custom number would couple documents to
 *  app state. */
export type LineMeasureSetting = LineMeasure | 'custom';

export const LINE_MEASURE_CUSTOM_MIN_CH = 40;
export const LINE_MEASURE_CUSTOM_MAX_CH = 120;

/** Clamp a custom measure to the stepper's range, on whole ch. */
export function clampLineMeasureCh(value: number): number {
  return Math.min(
    LINE_MEASURE_CUSTOM_MAX_CH,
    Math.max(LINE_MEASURE_CUSTOM_MIN_CH, Math.round(value))
  );
}

const LINE_MEASURES: readonly LineMeasure[] = [
  'narrow',
  'normal',
  'wide',
  'full'
];

/** Normalize an untrusted per-document override (folio docMeta key or
 *  frontmatter value) to a LineMeasure, or null when absent/invalid.
 *  Invalid values are ignored at read time, never rewritten on disk. */
export function parseLineMeasure(value: unknown): LineMeasure | null {
  return LINE_MEASURES.includes(value as LineMeasure)
    ? (value as LineMeasure)
    : null;
}

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
  lineMeasure: LineMeasureSetting;
  /** The column width in ch when `lineMeasure` is 'custom'. Kept when a
   *  preset is active so switching back to Custom restores the last value. */
  lineMeasureCustomCh: number;
  /** Paint a hairline at the writing column's edge (the measure rule). */
  showMeasureRule: boolean;
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
  lineMeasureCustomCh: 70,
  showMeasureRule: false,
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
    schemaVersion: 2,
    projectPath,
    projectName,
    lastOpenedMs: Date.now(),
    sidebar: {
      visible: true,
      width: DEFAULT_SIDEBAR_WIDTH,
      pinned: [],
      sortKey: 'name'
    },
    workingSet: []
  };
}
