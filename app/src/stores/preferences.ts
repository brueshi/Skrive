// App-wide preferences store. Mirrors `AppUiState` 1:1 (Phase 9 / A3).
//
// Hydrated once at app boot via `hydratePreferences()`. Every mutation
// schedules a debounced save (300ms tail). The beforeunload handler in
// `App.tsx` calls `persistNow()` so an in-flight debounce doesn't get
// dropped on quit.
//
// `recordRecentProject` keeps the list capped at
// `DEFAULT_RECENT_PROJECTS_CAP` and dedupes by canonical path; the
// most recent open lives at index 0.

import { create } from 'zustand';
import {
  DEFAULT_APP_UI_STATE,
  DEFAULT_RECENT_PROJECTS_CAP,
  type AppUiState,
  type EditorFontId,
  type PanelOpenBehaviorId,
  type RecentFile,
  type RecentProject,
  type ShellToneId,
  type ThemeId
} from '@skrive/shared';

const SAVE_DEBOUNCE_MS = 300;
const RECENT_FILES_CAP = 30;

type PreferencesState = AppUiState & {
  hydrated: boolean;
};

type PreferencesActions = {
  hydrate(): Promise<void>;
  persistNow(): Promise<void>;

  setEditorFont(font: EditorFontId): void;
  setEditorCustomFontFamily(family: string): void;
  setEditorFontSize(size: number): void;
  setEditorLineHeightX100(value: number): void;
  setSkipDeleteConfirmation(skip: boolean): void;
  setAutoUpdateOnLaunch(value: boolean): void;
  setPanelOpenBehavior(value: PanelOpenBehaviorId): void;
  setShellTone(value: ShellToneId): void;
  setTheme(value: ThemeId): void;

  addDictionaryWord(word: string): void;
  removeDictionaryWord(word: string): void;

  setLastOpenedProject(path: string | null): void;
  recordRecentProject(path: string, name: string): void;
  removeRecentProject(path: string): void;

  /** LRU bookkeeping for the file switcher (Phase 11). Most recent
   *  open lives at index 0; entries dedupe by `(projectPath, filePath)`
   *  and the list caps at RECENT_FILES_CAP. */
  recordRecentFile(projectPath: string, filePath: string): void;

  resetEditorDefaults(): void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savePromise: Promise<void> | null = null;

function snapshot(state: PreferencesState): AppUiState {
  return {
    schemaVersion: 1,
    lastOpenedProject: state.lastOpenedProject,
    recentProjects: state.recentProjects,
    license: state.license,
    firstRunMs: state.firstRunMs,
    personalDictionary: state.personalDictionary,
    skipDeleteConfirmation: state.skipDeleteConfirmation,
    recentFiles: state.recentFiles,
    editorFont: state.editorFont,
    editorCustomFontFamily: state.editorCustomFontFamily,
    editorFontSize: state.editorFontSize,
    editorLineHeightX100: state.editorLineHeightX100,
    autoUpdateOnLaunch: state.autoUpdateOnLaunch,
    panelOpenBehavior: state.panelOpenBehavior,
    shellTone: state.shellTone,
    theme: state.theme
  };
}

function scheduleSave(getState: () => PreferencesState): void {
  if (!getState().hydrated) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    savePromise = window.skrive.persistence
      .saveAppState(snapshot(getState()))
      .catch((err) => {
        console.error('[skrive preferences] saveAppState failed', err);
      });
  }, SAVE_DEBOUNCE_MS);
}

export const usePreferencesStore = create<
  PreferencesState & PreferencesActions
>((set, get) => ({
  ...DEFAULT_APP_UI_STATE,
  hydrated: false,

  async hydrate() {
    try {
      const state = await window.skrive.persistence.loadAppState();
      // Stamp firstRunMs the very first time. Persists immediately so
      // subsequent boots see the same timestamp.
      const firstRunMs = state.firstRunMs ?? Date.now();
      set({ ...state, firstRunMs, hydrated: true });
      if (state.firstRunMs === null) scheduleSave(get);
    } catch (err) {
      console.error('[skrive preferences] hydrate failed', err);
      set({ ...DEFAULT_APP_UI_STATE, firstRunMs: Date.now(), hydrated: true });
    }
  },

  async persistNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!get().hydrated) return;
    try {
      await window.skrive.persistence.saveAppState(snapshot(get()));
    } catch (err) {
      console.error('[skrive preferences] persistNow failed', err);
    }
    if (savePromise) {
      try {
        await savePromise;
      } catch {
        // already logged
      }
    }
  },

  setEditorFont(font) {
    if (get().editorFont === font) return;
    set({ editorFont: font });
    scheduleSave(get);
  },
  setEditorCustomFontFamily(family) {
    if (get().editorCustomFontFamily === family) return;
    set({ editorCustomFontFamily: family });
    scheduleSave(get);
  },
  setEditorFontSize(size) {
    if (get().editorFontSize === size) return;
    set({ editorFontSize: size });
    scheduleSave(get);
  },
  setEditorLineHeightX100(value) {
    if (get().editorLineHeightX100 === value) return;
    set({ editorLineHeightX100: value });
    scheduleSave(get);
  },
  setSkipDeleteConfirmation(skip) {
    if (get().skipDeleteConfirmation === skip) return;
    set({ skipDeleteConfirmation: skip });
    scheduleSave(get);
  },
  setAutoUpdateOnLaunch(value) {
    if (get().autoUpdateOnLaunch === value) return;
    set({ autoUpdateOnLaunch: value });
    scheduleSave(get);
  },
  setPanelOpenBehavior(value) {
    if (get().panelOpenBehavior === value) return;
    set({ panelOpenBehavior: value });
    scheduleSave(get);
  },
  setShellTone(value) {
    if (get().shellTone === value) return;
    set({ shellTone: value });
    scheduleSave(get);
  },
  setTheme(value) {
    if (get().theme === value) return;
    set({ theme: value });
    scheduleSave(get);
  },

  addDictionaryWord(word) {
    const trimmed = word.trim();
    if (trimmed.length === 0) return;
    const dict = get().personalDictionary;
    if (dict.some((w) => w.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
      return;
    }
    set({ personalDictionary: [...dict, trimmed] });
    scheduleSave(get);
  },
  removeDictionaryWord(word) {
    const dict = get().personalDictionary;
    const next = dict.filter(
      (w) => w.toLocaleLowerCase() !== word.toLocaleLowerCase()
    );
    if (next.length === dict.length) return;
    set({ personalDictionary: next });
    scheduleSave(get);
  },

  setLastOpenedProject(p) {
    if (get().lastOpenedProject === p) return;
    set({ lastOpenedProject: p });
    scheduleSave(get);
  },
  recordRecentProject(p, name) {
    const now = Date.now();
    const existing = get().recentProjects.filter((r) => r.path !== p);
    const next: RecentProject[] = [
      { path: p, name, lastOpenedMs: now },
      ...existing
    ].slice(0, DEFAULT_RECENT_PROJECTS_CAP);
    set({ recentProjects: next });
    scheduleSave(get);
  },
  removeRecentProject(p) {
    const next = get().recentProjects.filter((r) => r.path !== p);
    if (next.length === get().recentProjects.length) return;
    set({ recentProjects: next });
    scheduleSave(get);
  },

  recordRecentFile(projectPath, filePath) {
    const now = Date.now();
    const existing = get().recentFiles.filter(
      (r) => !(r.projectPath === projectPath && r.filePath === filePath)
    );
    const next: RecentFile[] = [
      { projectPath, filePath, openedMs: now },
      ...existing
    ].slice(0, RECENT_FILES_CAP);
    set({ recentFiles: next });
    scheduleSave(get);
  },

  resetEditorDefaults() {
    set({
      editorFont: DEFAULT_APP_UI_STATE.editorFont,
      editorCustomFontFamily: DEFAULT_APP_UI_STATE.editorCustomFontFamily,
      editorFontSize: DEFAULT_APP_UI_STATE.editorFontSize,
      editorLineHeightX100: DEFAULT_APP_UI_STATE.editorLineHeightX100
    });
    scheduleSave(get);
  }
}));
