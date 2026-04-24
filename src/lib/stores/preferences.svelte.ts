// App-wide preferences store. Wraps the Rust `load_app_state` /
// `save_app_state` Tauri commands and exposes the persisted state as
// reactive Svelte runes that the rest of the frontend can read directly.
//
// What lives here vs. the project store: anything in `AppUiState` is
// "preferences" — settings that survive across project switches and app
// restarts and are *not* tied to any particular project. The personal
// dictionary is the first real consumer; recent-projects history and
// license storage will move through here as we get to them.
//
// Persistence is debounced (400ms) to avoid thrashing app.json on every
// keystroke when the user is editing the personal dictionary panel.

import { invoke } from "@tauri-apps/api/core";
import type {
  AppUiState,
  EditorFontId,
  RecentFile,
  RecentProject,
} from "$lib/types";

const DEBOUNCE_MS = 400;
const SCHEMA_VERSION = 1;

// Module-level reactive state. The whole `AppUiState` shape is mirrored
// here so anything we add to the Rust side just needs a getter on the
// `preferences` export below.
let personalDictionary = $state<string[]>([]);
let lastOpenedProject = $state<string | null>(null);
let recentProjects = $state<RecentProject[]>([]);
let firstRunMs = $state<number | null>(null);
let license = $state<string | null>(null);
let skipDeleteConfirmation = $state(false);
let recentFiles = $state<RecentFile[]>([]);
let editorFont = $state<EditorFontId>("editorial");
let editorCustomFontFamily = $state("");
let editorFontSize = $state(17);
let editorLineHeightX100 = $state(170);
let autoUpdateOnLaunch = $state(true);

// Defaults exported so the Settings "Reset to defaults" button uses the
// same values as the Rust-side `Default for AppUiState`. Single source
// of truth lives on the Rust side; these are mirrors.
export const DEFAULT_EDITOR_FONT: EditorFontId = "editorial";
export const DEFAULT_EDITOR_FONT_SIZE = 17;
export const DEFAULT_EDITOR_LINE_HEIGHT_X100 = 170;

// Cap the persisted list so app.json stays small. A writer who opens
// 50 distinct files across all projects is well-served; anything past
// that is cold history and not worth the storage cost.
const RECENT_FILES_CAP = 50;
// Recent projects are a far smaller set — the EmptyState list is the
// main consumer and showing more than ~10 becomes noise.
const RECENT_PROJECTS_CAP = 10;

// Panel open/closed state. *Session only* — the dictionary panel is a
// transient tool, not a layout preference, so it doesn't get persisted
// in app.json. Same pattern as `frontmatterPanelOpen` in the project
// store.
let dictionaryPanelOpen = $state(false);

// Track whether we've completed the initial load so individual setters
// don't trigger a save before we've seen the on-disk state. Without this
// guard, setters fired during component setup would write defaults over
// real persisted data.
let loaded = false;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function loadOnceImpl(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const state = await invoke<AppUiState>("load_app_state");
    personalDictionary = Array.isArray(state.personalDictionary)
      ? state.personalDictionary
      : [];
    lastOpenedProject = state.lastOpenedProject ?? null;
    recentProjects = Array.isArray(state.recentProjects)
      ? state.recentProjects
      : [];
    firstRunMs = state.firstRunMs ?? null;
    license = state.license ?? null;
    skipDeleteConfirmation = Boolean(state.skipDeleteConfirmation);
    recentFiles = Array.isArray(state.recentFiles) ? state.recentFiles : [];
    editorFont = sanitizeFontId(state.editorFont);
    editorCustomFontFamily =
      typeof state.editorCustomFontFamily === "string"
        ? state.editorCustomFontFamily
        : "";
    editorFontSize = sanitizeFontSize(state.editorFontSize);
    editorLineHeightX100 = sanitizeLineHeightX100(state.editorLineHeightX100);
    autoUpdateOnLaunch =
      typeof state.autoUpdateOnLaunch === "boolean"
        ? state.autoUpdateOnLaunch
        : true;
  } catch (err) {
    // A read failure (corrupt JSON, missing file the Rust side
    // didn't recreate, permission denied) is non-fatal. We keep the
    // defaults; subsequent saves will write a fresh file.
    console.warn("Failed to load app preferences:", err);
  }
}

function scheduleSave(): void {
  if (!loaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, DEBOUNCE_MS);
}

async function flushSave(): Promise<void> {
  const uiState: AppUiState = {
    schemaVersion: SCHEMA_VERSION,
    lastOpenedProject,
    recentProjects,
    license,
    firstRunMs,
    personalDictionary,
    skipDeleteConfirmation,
    recentFiles,
    editorFont,
    editorCustomFontFamily,
    editorFontSize,
    editorLineHeightX100,
    autoUpdateOnLaunch,
  };
  try {
    await invoke("save_app_state", { uiState });
  } catch (err) {
    console.warn("Failed to save app preferences:", err);
  }
}

// =========================== Typography sanitizers ===========================

const VALID_FONT_IDS: readonly EditorFontId[] = [
  "editorial",
  "classic",
  "screen",
  "sans",
  "mono",
  "custom",
];

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 28;
const LINE_HEIGHT_X100_MIN = 100;
const LINE_HEIGHT_X100_MAX = 250;

function sanitizeFontId(value: unknown): EditorFontId {
  return typeof value === "string" &&
    (VALID_FONT_IDS as readonly string[]).includes(value)
    ? (value as EditorFontId)
    : DEFAULT_EDITOR_FONT;
}

function sanitizeFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_EDITOR_FONT_SIZE;
  }
  const rounded = Math.round(value);
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, rounded));
}

function sanitizeLineHeightX100(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_EDITOR_LINE_HEIGHT_X100;
  }
  const rounded = Math.round(value);
  return Math.max(LINE_HEIGHT_X100_MIN, Math.min(LINE_HEIGHT_X100_MAX, rounded));
}

// =========================== Personal dictionary actions ===========================

/**
 * Add a word to the personal dictionary. No-op if the word is empty,
 * whitespace-only, or already present (case-insensitive). Words are
 * stored with whatever case the user typed; matching against the editor
 * is case-insensitive at the decoration layer.
 */
function addPersonalWordImpl(word: string): void {
  const trimmed = word.trim();
  if (trimmed.length === 0) return;
  const lower = trimmed.toLowerCase();
  for (const existing of personalDictionary) {
    if (existing.toLowerCase() === lower) return;
  }
  personalDictionary = [...personalDictionary, trimmed];
  scheduleSave();
}

/**
 * Remove a word from the personal dictionary. Match is case-insensitive
 * so the panel's × button works regardless of the casing the user
 * entered originally.
 */
function removePersonalWordImpl(word: string): void {
  const lower = word.trim().toLowerCase();
  if (lower.length === 0) return;
  const next = personalDictionary.filter(
    (w) => w.toLowerCase() !== lower,
  );
  if (next.length === personalDictionary.length) return;
  personalDictionary = next;
  scheduleSave();
}

// =========================== Panel actions ===========================

function openDictionaryPanelImpl(): void {
  dictionaryPanelOpen = true;
}

function closeDictionaryPanelImpl(): void {
  dictionaryPanelOpen = false;
}

function toggleDictionaryPanelImpl(): void {
  dictionaryPanelOpen = !dictionaryPanelOpen;
}

// =========================== Delete-confirm preference ===========================

/**
 * Persist the "Don't ask again" choice from the delete confirmation modal.
 * Kept as a setter rather than a toggle so callers can only opt *in* from
 * the checkbox path — resetting it back to false is a future Settings
 * surface concern, not a per-delete one.
 */
function setSkipDeleteConfirmationImpl(value: boolean): void {
  skipDeleteConfirmation = value;
  scheduleSave();
}

// =========================== Recent files ===========================

/**
 * Record a file-open in the recent list. Idempotent for repeated opens
 * of the same file — the existing entry is removed and re-pushed with
 * a fresh timestamp so recency sort is trivial. Capped so the persisted
 * list stays small.
 */
function pushRecentFileImpl(projectPath: string, filePath: string): void {
  if (!projectPath || !filePath) return;
  const next = recentFiles.filter(
    (r) => !(r.projectPath === projectPath && r.filePath === filePath),
  );
  next.unshift({ projectPath, filePath, openedMs: Date.now() });
  if (next.length > RECENT_FILES_CAP) next.length = RECENT_FILES_CAP;
  recentFiles = next;
  scheduleSave();
}

/**
 * Drop any recent-file entry whose path is gone from disk. The command
 * palette calls this when it notices a stale entry so the next render
 * is clean. Returns `true` if anything changed, to let callers skip
 * redundant re-renders.
 */
function removeRecentFileImpl(projectPath: string, filePath: string): boolean {
  const next = recentFiles.filter(
    (r) => !(r.projectPath === projectPath && r.filePath === filePath),
  );
  if (next.length === recentFiles.length) return false;
  recentFiles = next;
  scheduleSave();
  return true;
}

// =========================== Recent projects ===========================

/**
 * Record a project-open in the recent-projects LRU. Same pattern as
 * `pushRecentFile`: existing entries move to the front with a refreshed
 * timestamp, so recency sort stays simple. The EmptyState and the
 * (eventual) project menu read straight off this list.
 */
function pushRecentProjectImpl(path: string, name: string): void {
  if (!path || !name) return;
  const next = recentProjects.filter((r) => r.path !== path);
  next.unshift({ path, name, lastOpenedMs: Date.now() });
  if (next.length > RECENT_PROJECTS_CAP) next.length = RECENT_PROJECTS_CAP;
  recentProjects = next;
  scheduleSave();
}

/**
 * Remove a recent-projects entry. Used by the EmptyState × button so
 * the user can prune projects they've moved, renamed, or are done with,
 * and by cleanup paths when a path is confirmed gone from disk.
 */
function removeRecentProjectImpl(path: string): boolean {
  const next = recentProjects.filter((r) => r.path !== path);
  if (next.length === recentProjects.length) return false;
  recentProjects = next;
  scheduleSave();
  return true;
}

// =========================== Typography setters ===========================

function setEditorFontImpl(id: EditorFontId): void {
  if (!(VALID_FONT_IDS as readonly string[]).includes(id)) return;
  if (editorFont === id) return;
  editorFont = id;
  scheduleSave();
}

function setEditorCustomFontFamilyImpl(family: string): void {
  // Trim leading/trailing whitespace but preserve internal — font
  // names can legitimately contain spaces ("Iowan Old Style").
  const trimmed = family.trim();
  if (editorCustomFontFamily === trimmed) return;
  editorCustomFontFamily = trimmed;
  scheduleSave();
}

function setEditorFontSizeImpl(size: number): void {
  const next = sanitizeFontSize(size);
  if (editorFontSize === next) return;
  editorFontSize = next;
  scheduleSave();
}

function setEditorLineHeightX100Impl(value: number): void {
  const next = sanitizeLineHeightX100(value);
  if (editorLineHeightX100 === next) return;
  editorLineHeightX100 = next;
  scheduleSave();
}

function resetEditorTypographyImpl(): void {
  let changed = false;
  if (editorFont !== DEFAULT_EDITOR_FONT) {
    editorFont = DEFAULT_EDITOR_FONT;
    changed = true;
  }
  if (editorCustomFontFamily !== "") {
    editorCustomFontFamily = "";
    changed = true;
  }
  if (editorFontSize !== DEFAULT_EDITOR_FONT_SIZE) {
    editorFontSize = DEFAULT_EDITOR_FONT_SIZE;
    changed = true;
  }
  if (editorLineHeightX100 !== DEFAULT_EDITOR_LINE_HEIGHT_X100) {
    editorLineHeightX100 = DEFAULT_EDITOR_LINE_HEIGHT_X100;
    changed = true;
  }
  if (changed) scheduleSave();
}

// =========================== Auto-update setter ===========================

function setAutoUpdateOnLaunchImpl(value: boolean): void {
  if (autoUpdateOnLaunch === value) return;
  autoUpdateOnLaunch = value;
  scheduleSave();
}

// =========================== Public API ===========================

export const preferences = {
  get personalDictionary() {
    return personalDictionary;
  },
  get lastOpenedProject() {
    return lastOpenedProject;
  },
  get recentProjects() {
    return recentProjects;
  },
  get firstRunMs() {
    return firstRunMs;
  },
  get license() {
    return license;
  },
  get dictionaryPanelOpen() {
    return dictionaryPanelOpen;
  },
  get skipDeleteConfirmation() {
    return skipDeleteConfirmation;
  },
  get recentFiles() {
    return recentFiles;
  },
  get editorFont(): EditorFontId {
    return editorFont;
  },
  get editorCustomFontFamily() {
    return editorCustomFontFamily;
  },
  get editorFontSize() {
    return editorFontSize;
  },
  get editorLineHeightX100() {
    return editorLineHeightX100;
  },
  get autoUpdateOnLaunch() {
    return autoUpdateOnLaunch;
  },

  loadOnce: loadOnceImpl,
  addPersonalWord: addPersonalWordImpl,
  removePersonalWord: removePersonalWordImpl,
  openDictionaryPanel: openDictionaryPanelImpl,
  closeDictionaryPanel: closeDictionaryPanelImpl,
  toggleDictionaryPanel: toggleDictionaryPanelImpl,
  setSkipDeleteConfirmation: setSkipDeleteConfirmationImpl,
  pushRecentFile: pushRecentFileImpl,
  removeRecentFile: removeRecentFileImpl,
  pushRecentProject: pushRecentProjectImpl,
  removeRecentProject: removeRecentProjectImpl,
  setEditorFont: setEditorFontImpl,
  setEditorCustomFontFamily: setEditorCustomFontFamilyImpl,
  setEditorFontSize: setEditorFontSizeImpl,
  setEditorLineHeightX100: setEditorLineHeightX100Impl,
  resetEditorTypography: resetEditorTypographyImpl,
  setAutoUpdateOnLaunch: setAutoUpdateOnLaunchImpl,
};
