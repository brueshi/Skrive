// UI-state persistence (Phase 9). Pure module — no IPC, no Electron
// app-handle resolution. Callers (`shell/src/ipc/persistence.ts`)
// supply the userData directory.
//
// Mirrors the algorithm in `src-tauri/src/persistence.rs` so a state
// file written by v0.1.6 (Tauri) loads cleanly under v0.2 (Electron)
// and vice versa: same hash, same atomic write, same camelCase keys
// already enforced by the shared types.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_APP_UI_STATE,
  defaultProjectUiState,
  type AppUiState,
  type ProjectUiState
} from '@skrive/shared';

/** First 16 hex chars of SHA-256 of the canonical project path.
 *  Stable across sessions, collision-resistant for any reasonable
 *  number of projects per user, safe as a filename on every platform. */
export function hashProjectPath(canonicalProjectPath: string): string {
  return createHash('sha256')
    .update(canonicalProjectPath)
    .digest('hex')
    .slice(0, 16);
}

export function appStateFile(userDataDir: string): string {
  return path.join(userDataDir, 'app.json');
}

export function projectStateFile(
  userDataDir: string,
  canonicalProjectPath: string
): string {
  const hash = hashProjectPath(canonicalProjectPath);
  return path.join(userDataDir, 'projects', `${hash}.json`);
}

// ============================ Reads ============================

export async function loadAppState(userDataDir: string): Promise<AppUiState> {
  const file = appStateFile(userDataDir);
  const raw = await safeReadJson(file);
  if (raw === null) return cloneAppDefaults();
  return migrateAppState(raw);
}

export async function loadProjectState(
  userDataDir: string,
  canonicalProjectPath: string
): Promise<ProjectUiState | null> {
  const file = projectStateFile(userDataDir, canonicalProjectPath);
  const raw = await safeReadJson(file);
  if (raw === null) return null;
  return migrateProjectState(raw, canonicalProjectPath);
}

// ============================ Writes ============================

export async function saveAppState(
  userDataDir: string,
  state: AppUiState
): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await atomicWriteJson(appStateFile(userDataDir), state);
}

export async function saveProjectState(
  userDataDir: string,
  canonicalProjectPath: string,
  state: ProjectUiState
): Promise<void> {
  const file = projectStateFile(userDataDir, canonicalProjectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteJson(file, state);
}

// ============================ Internals ============================

async function safeReadJson(file: string): Promise<unknown | null> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn(`[skrive persistence] read failed for ${file}:`, err);
    return null;
  }
  try {
    return JSON.parse(content);
  } catch (err) {
    console.warn(`[skrive persistence] parse failed for ${file}:`, err);
    return null;
  }
}

/** Write atomically: serialize → `.tmp` sibling → rename. The rename
 *  is atomic on POSIX; on Windows fs.promises.rename overwrites
 *  silently in modern Node, which is good enough for state files
 *  measured in kilobytes. */
async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  const content = JSON.stringify(value, null, 2);
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // Clean up the half-written tmp before re-throwing — leaving it
    // around could be picked up by a future load attempt.
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// ============================ Migrations ============================
//
// Phase 9 ships v1; v0.1.6 also wrote v1, so a clean v1 file passes
// through unchanged. Migration scaffolding exists for future bumps —
// the load path checks the schemaVersion and dispatches; unknown-future
// versions fall back to defaults with a console warning rather than
// crashing or trying to interpret a newer schema.

export function migrateAppState(raw: unknown): AppUiState {
  if (!isObject(raw)) return cloneAppDefaults();
  const version = numberField(raw, 'schemaVersion', 1);
  if (version > 1) {
    console.warn(
      `[skrive persistence] app.json has schemaVersion ${version}; this build understands v1. Falling back to defaults.`
    );
    return cloneAppDefaults();
  }
  // v1 = current. Merge over defaults so older v0.1.6 files missing
  // newer fields (recentFiles, editor* fields, etc.) load with sane
  // defaults instead of `undefined` leaking into the renderer store.
  const defaults = cloneAppDefaults();
  return {
    ...defaults,
    ...sanitizeAppState(raw),
    schemaVersion: 1
  };
}

export function migrateProjectState(
  raw: unknown,
  canonicalProjectPath: string
): ProjectUiState {
  if (!isObject(raw)) {
    return defaultProjectUiState(canonicalProjectPath, '');
  }
  const version = numberField(raw, 'schemaVersion', 1);
  if (version > 1) {
    console.warn(
      `[skrive persistence] project state for ${canonicalProjectPath} has schemaVersion ${version}; this build understands v1. Discarding.`
    );
    return defaultProjectUiState(canonicalProjectPath, '');
  }
  return sanitizeProjectState(raw, canonicalProjectPath);
}

function sanitizeAppState(raw: Record<string, unknown>): Partial<AppUiState> {
  const out: Partial<AppUiState> = {};
  if (typeof raw.lastOpenedProject === 'string') {
    out.lastOpenedProject = raw.lastOpenedProject;
  } else if (raw.lastOpenedProject === null) {
    out.lastOpenedProject = null;
  }
  if (Array.isArray(raw.recentProjects)) {
    out.recentProjects = raw.recentProjects.filter(
      (entry): entry is AppUiState['recentProjects'][number] =>
        isObject(entry) &&
        typeof entry.path === 'string' &&
        typeof entry.name === 'string' &&
        typeof entry.lastOpenedMs === 'number'
    );
  }
  if (typeof raw.license === 'string' || raw.license === null) {
    out.license = raw.license;
  }
  if (typeof raw.firstRunMs === 'number' || raw.firstRunMs === null) {
    out.firstRunMs = raw.firstRunMs as number | null;
  }
  if (Array.isArray(raw.personalDictionary)) {
    out.personalDictionary = raw.personalDictionary.filter(
      (w): w is string => typeof w === 'string'
    );
  }
  if (typeof raw.skipDeleteConfirmation === 'boolean') {
    out.skipDeleteConfirmation = raw.skipDeleteConfirmation;
  }
  if (Array.isArray(raw.recentFiles)) {
    out.recentFiles = raw.recentFiles.filter(
      (entry): entry is AppUiState['recentFiles'][number] =>
        isObject(entry) &&
        typeof entry.projectPath === 'string' &&
        typeof entry.filePath === 'string' &&
        typeof entry.openedMs === 'number'
    );
  }
  if (
    raw.editorFont === 'editorial' ||
    raw.editorFont === 'classic' ||
    raw.editorFont === 'screen' ||
    raw.editorFont === 'sans' ||
    raw.editorFont === 'mono' ||
    raw.editorFont === 'custom'
  ) {
    out.editorFont = raw.editorFont;
  }
  if (typeof raw.editorCustomFontFamily === 'string') {
    out.editorCustomFontFamily = raw.editorCustomFontFamily;
  }
  if (typeof raw.editorFontSize === 'number') {
    out.editorFontSize = raw.editorFontSize;
  }
  if (typeof raw.editorLineHeightX100 === 'number') {
    out.editorLineHeightX100 = raw.editorLineHeightX100;
  }
  if (typeof raw.autoUpdateOnLaunch === 'boolean') {
    out.autoUpdateOnLaunch = raw.autoUpdateOnLaunch;
  }
  // Theme: explicit stored value wins; an existing app.json without
  // any theme field is a pre-v0.2.2 user who only ever knew dark mode,
  // so we migrate them to 'dark' rather than the new-install default
  // ('light') to avoid theme whiplash on upgrade.
  if (
    raw.theme === 'system' ||
    raw.theme === 'light' ||
    raw.theme === 'dark'
  ) {
    out.theme = raw.theme;
  } else {
    out.theme = 'dark';
  }
  if (typeof raw.showOutlineRail === 'boolean') {
    out.showOutlineRail = raw.showOutlineRail;
  }
  if (raw.defaultSurface === 'text' || raw.defaultSurface === 'rich') {
    out.defaultSurface = raw.defaultSurface;
  }
  if (typeof raw.surfaceSwitchingEnabled === 'boolean') {
    out.surfaceSwitchingEnabled = raw.surfaceSwitchingEnabled;
  }
  if (
    raw.markerMode === 'raw' ||
    raw.markerMode === 'recessed' ||
    raw.markerMode === 'concealed'
  ) {
    out.markerMode = raw.markerMode;
  }
  // Skrive 1.0 settings. Each whitelists its own shape; an absent or
  // malformed field falls through to the default in cloneAppDefaults().
  if (
    raw.lineMeasure === 'narrow' ||
    raw.lineMeasure === 'normal' ||
    raw.lineMeasure === 'wide'
  ) {
    out.lineMeasure = raw.lineMeasure;
  }
  if (typeof raw.smartTypography === 'boolean') {
    out.smartTypography = raw.smartTypography;
  }
  if (typeof raw.formatOnSave === 'boolean') {
    out.formatOnSave = raw.formatOnSave;
  }
  if (
    typeof raw.autosaveIdleDelayMs === 'number' &&
    Number.isFinite(raw.autosaveIdleDelayMs)
  ) {
    out.autosaveIdleDelayMs = raw.autosaveIdleDelayMs;
  }
  if (
    raw.newFileLocation === 'activeFolder' ||
    raw.newFileLocation === 'projectRoot'
  ) {
    out.newFileLocation = raw.newFileLocation;
  }
  if (raw.newFileNaming === 'title' || raw.newFileNaming === 'untitled') {
    out.newFileNaming = raw.newFileNaming;
  }
  if (raw.slugFormat === 'kebab-case' || raw.slugFormat === 'snake_case') {
    out.slugFormat = raw.slugFormat;
  }
  if (typeof raw.gitHistoryEnabled === 'boolean') {
    out.gitHistoryEnabled = raw.gitHistoryEnabled;
  }
  if (typeof raw.seedFrontmatter === 'boolean') {
    out.seedFrontmatter = raw.seedFrontmatter;
  }
  if (Array.isArray(raw.frontmatterFields)) {
    out.frontmatterFields = raw.frontmatterFields.filter(
      (f): f is string => typeof f === 'string'
    );
  }
  if (typeof raw.dateFormat === 'string') {
    out.dateFormat = raw.dateFormat;
  }
  return out;
}

function sanitizeProjectState(
  raw: Record<string, unknown>,
  canonicalProjectPath: string
): ProjectUiState {
  const fallback = defaultProjectUiState(
    typeof raw.projectPath === 'string'
      ? raw.projectPath
      : canonicalProjectPath,
    typeof raw.projectName === 'string' ? raw.projectName : ''
  );
  const sidebar =
    isObject(raw.sidebar) &&
    typeof raw.sidebar.visible === 'boolean' &&
    typeof raw.sidebar.width === 'number'
      ? { visible: raw.sidebar.visible, width: raw.sidebar.width }
      : fallback.sidebar;
  const tabs = Array.isArray(raw.tabs)
    ? raw.tabs
        .map((entry) => sanitizeTabState(entry))
        .filter((entry): entry is ProjectUiState['tabs'][number] => entry !== null)
    : fallback.tabs;
  const activeTabIndex =
    typeof raw.activeTabIndex === 'number'
      ? Math.max(-1, Math.min(raw.activeTabIndex, tabs.length - 1))
      : -1;
  return {
    schemaVersion: 1,
    projectPath: fallback.projectPath,
    projectName: fallback.projectName,
    lastOpenedMs:
      typeof raw.lastOpenedMs === 'number' ? raw.lastOpenedMs : Date.now(),
    sidebar,
    tabs,
    activeTabIndex
  };
}

function sanitizeTabState(raw: unknown): ProjectUiState['tabs'][number] | null {
  if (!isObject(raw)) return null;
  if (typeof raw.path !== 'string') return null;
  const layoutMode =
    raw.layoutMode === 'raw' ||
    raw.layoutMode === 'split' ||
    raw.layoutMode === 'preview'
      ? raw.layoutMode
      : 'split';
  const cursor = isObject(raw.cursor)
    ? {
        line: typeof raw.cursor.line === 'number' ? raw.cursor.line : 1,
        column: typeof raw.cursor.column === 'number' ? raw.cursor.column : 0
      }
    : { line: 1, column: 0 };
  const scrollTop =
    typeof raw.scrollTop === 'number' ? raw.scrollTop : 0;
  const splitDividerRatio =
    typeof raw.splitDividerRatio === 'number' ? raw.splitDividerRatio : 0.5;
  return {
    path: raw.path,
    layoutMode,
    cursor,
    scrollTop,
    splitDividerRatio
  };
}

function cloneAppDefaults(): AppUiState {
  return {
    ...DEFAULT_APP_UI_STATE,
    recentProjects: [],
    personalDictionary: [],
    recentFiles: [],
    // Fresh array so a clone can't alias (and later mutate) the shared
    // default; mirrors the other array fields reset above.
    frontmatterFields: [...DEFAULT_APP_UI_STATE.frontmatterFields]
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(
  raw: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const value = raw[key];
  return typeof value === 'number' ? value : fallback;
}
