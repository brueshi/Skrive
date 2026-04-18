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
import type { AppUiState, RecentFile, RecentProject } from "$lib/types";

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

// Cap the persisted list so app.json stays small. A writer who opens
// 50 distinct files across all projects is well-served; anything past
// that is cold history and not worth the storage cost.
const RECENT_FILES_CAP = 50;

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
  };
  try {
    await invoke("save_app_state", { uiState });
  } catch (err) {
    console.warn("Failed to save app preferences:", err);
  }
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

  loadOnce: loadOnceImpl,
  addPersonalWord: addPersonalWordImpl,
  removePersonalWord: removePersonalWordImpl,
  openDictionaryPanel: openDictionaryPanelImpl,
  closeDictionaryPanel: closeDictionaryPanelImpl,
  toggleDictionaryPanel: toggleDictionaryPanelImpl,
  setSkipDeleteConfirmation: setSkipDeleteConfirmationImpl,
  pushRecentFile: pushRecentFileImpl,
  removeRecentFile: removeRecentFileImpl,
};
