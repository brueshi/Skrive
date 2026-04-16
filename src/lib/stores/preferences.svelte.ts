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
import type { AppUiState, RecentProject } from "$lib/types";

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

  loadOnce: loadOnceImpl,
  addPersonalWord: addPersonalWordImpl,
  removePersonalWord: removePersonalWordImpl,
  openDictionaryPanel: openDictionaryPanelImpl,
  closeDictionaryPanel: closeDictionaryPanelImpl,
  toggleDictionaryPanel: toggleDictionaryPanelImpl,
};
