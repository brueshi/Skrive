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

export type SidebarState = {
  visible: boolean;
  width: number;
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

/** Inset-design forks that remain user-toggleable. The losers (topbar
 *  layout variants, inset coverage, sidebar style) are now hardcoded
 *  to their chosen defaults. */
export type PanelOpenBehaviorId = 'push' | 'float';
export type ShellToneId = 'dark' | 'same' | 'light';

/** Color theme. 'system' follows the OS via prefers-color-scheme;
 *  'light' / 'dark' override. Default for new installs is 'light';
 *  legacy users without a stored theme migrate to 'dark' (the only
 *  theme that existed before v0.2.2) so they don't get whiplash. */
export type ThemeId = 'system' | 'light' | 'dark';

/** Default editing surface. 'text' is the CodeMirror Source/Recessed surface
 *  (the shipped default); 'rich' is the ProseMirror projection surface. The
 *  projection editor (planning/projection-editor-master-plan.md) will make
 *  'rich' the default once surface switching lands; until then 'rich' is opt-in. */
export type SurfaceId = 'text' | 'rich';

/** How the Text (CodeMirror) surface treats Markdown syntax markers. A
 *  Text-surface nicety, independent of which surface is default:
 *   - 'raw'       — every marker shown at full strength (honest source).
 *   - 'recessed'  — markers visible but dimmed; prose leads, syntax recedes.
 *   - 'concealed' — markers hidden except on the line being edited (live-preview).
 *  The Rich surface hides syntax entirely, so this only affects Text. */
export type MarkerMode = 'raw' | 'recessed' | 'concealed';

export type AppUiState = {
  schemaVersion: 1;
  lastOpenedProject: string | null;
  recentProjects: RecentProject[];
  /** License key (post-Phase 9 UI). Field shipped now so the on-disk
   *  shape stays stable across the eventual license-entry surface. */
  license: string | null;
  /** Unix milliseconds; set the first time the app boots. */
  firstRunMs: number | null;
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
  panelOpenBehavior: PanelOpenBehaviorId;
  shellTone: ShellToneId;
  theme: ThemeId;
  /** Show the outline rail down the right edge of the preview. */
  showOutlineRail: boolean;
  /** Which editing surface new tabs open in. */
  defaultSurface: SurfaceId;
  /** Whether the writer may switch surfaces (⌘⇧E / the palette command).
   *  When false the surface is locked to `defaultSurface` — the escape hatch
   *  for a never-seen-Markdown writer who should never be one keystroke from
   *  raw syntax, and for anyone who wants a single, stable editing model. */
  surfaceSwitchingEnabled: boolean;
  /** How the Text surface renders Markdown markers (raw / recessed / concealed). */
  markerMode: MarkerMode;
};

export const DEFAULT_RECENT_PROJECTS_CAP = 10;

export const DEFAULT_APP_UI_STATE: AppUiState = {
  schemaVersion: 1,
  lastOpenedProject: null,
  recentProjects: [],
  license: null,
  firstRunMs: null,
  personalDictionary: [],
  skipDeleteConfirmation: false,
  recentFiles: [],
  editorFont: 'editorial',
  editorCustomFontFamily: '',
  editorFontSize: 17,
  editorLineHeightX100: 170,
  autoUpdateOnLaunch: true,
  panelOpenBehavior: 'push',
  shellTone: 'light',
  theme: 'light',
  showOutlineRail: true,
  defaultSurface: 'text',
  surfaceSwitchingEnabled: true,
  markerMode: 'recessed'
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
    sidebar: { visible: true, width: DEFAULT_SIDEBAR_WIDTH },
    tabs: [],
    activeTabIndex: -1
  };
}
