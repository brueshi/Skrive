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
  type LineMeasure,
  type NewFileLocation,
  type NewFileNaming,
  type RecentFile,
  type RecentProject,
  type SlugFormat,
  type ThemeId,
  type WordCountMetric
} from '@skrive/shared';

const SAVE_DEBOUNCE_MS = 300;
const RECENT_FILES_CAP = 30;

/** Autosave idle-delay bounds (ms). The Settings stepper steps within
 *  this range; the setter clamps to it so a stored or stepped value can
 *  never drive the autosave debounce out of a sane window. */
export const AUTOSAVE_IDLE_MIN_MS = 250;
export const AUTOSAVE_IDLE_MAX_MS = 3000;
export const AUTOSAVE_IDLE_STEP_MS = 250;

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
  /** Record that the one-time feedback nudge has been shown so it
   *  never fires again. */
  setSeenFeedbackPrompt(value: boolean): void;
  setAutoUpdateOnLaunch(value: boolean): void;
  setTheme(value: ThemeId): void;
  setShowOutlineRail(value: boolean): void;
  setShowWordCount(value: boolean): void;
  setWordCountMetric(value: WordCountMetric): void;

  setLineMeasure(value: LineMeasure): void;
  setSmartTypography(value: boolean): void;
  setFormatOnSave(value: boolean): void;
  setAutosaveIdleDelayMs(value: number): void;
  setNewFileLocation(value: NewFileLocation): void;
  setNewFileNaming(value: NewFileNaming): void;
  setSlugFormat(value: SlugFormat): void;
  /** Persist the git-history preference. Pure: it only stores the value.
   *  Project-side coordination (pushing it to the shell and refreshing the
   *  open project's history) lives in the project store's action of the
   *  same name, which calls this. */
  setGitHistoryEnabled(value: boolean): void;
  setSeedFrontmatter(value: boolean): void;
  setFrontmatterFields(value: string[]): void;
  setDateFormat(value: string): void;

  addDictionaryWord(word: string): void;
  removeDictionaryWord(word: string): void;

  setLastOpenedProject(path: string | null): void;
  recordRecentProject(path: string, name: string): void;
  removeRecentProject(path: string): void;

  /** App-wide recent-files LRU. Since SKR-243 the switcher reads the
   *  working set instead; the sidebar's Recents section is the last
   *  reader and dies with the Stage 2 desk (this bookkeeping goes with
   *  it). Most recent open lives at index 0; entries dedupe by
   *  `(projectPath, filePath)` and the list caps at RECENT_FILES_CAP. */
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
    launchCount: state.launchCount,
    seenFeedbackPrompt: state.seenFeedbackPrompt,
    personalDictionary: state.personalDictionary,
    skipDeleteConfirmation: state.skipDeleteConfirmation,
    recentFiles: state.recentFiles,
    editorFont: state.editorFont,
    editorCustomFontFamily: state.editorCustomFontFamily,
    editorFontSize: state.editorFontSize,
    editorLineHeightX100: state.editorLineHeightX100,
    autoUpdateOnLaunch: state.autoUpdateOnLaunch,
    theme: state.theme,
    showOutlineRail: state.showOutlineRail,
    showWordCount: state.showWordCount,
    wordCountMetric: state.wordCountMetric,
    defaultSurface: state.defaultSurface,
    surfaceSwitchingEnabled: state.surfaceSwitchingEnabled,
    markerMode: state.markerMode,
    lineMeasure: state.lineMeasure,
    smartTypography: state.smartTypography,
    formatOnSave: state.formatOnSave,
    autosaveIdleDelayMs: state.autosaveIdleDelayMs,
    newFileLocation: state.newFileLocation,
    newFileNaming: state.newFileNaming,
    slugFormat: state.slugFormat,
    gitHistoryEnabled: state.gitHistoryEnabled,
    seedFrontmatter: state.seedFrontmatter,
    frontmatterFields: state.frontmatterFields,
    dateFormat: state.dateFormat
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
    // Idempotent: React StrictMode double-invokes the boot effect in
    // dev, and we bump launchCount here — running twice would inflate
    // the counter (and re-trip the firstRun stamp). One hydrate per boot.
    if (get().hydrated) return;
    try {
      const state = await window.skrive.persistence.loadAppState();
      // Stamp firstRunMs the very first time. Persists immediately so
      // subsequent boots see the same timestamp.
      const firstRunMs = state.firstRunMs ?? Date.now();
      set({
        ...state,
        firstRunMs,
        launchCount: state.launchCount + 1,
        hydrated: true
      });
      // launchCount always changed, so always persist (no longer gated
      // on the firstRun stamp alone).
      scheduleSave(get);
    } catch (err) {
      console.error('[skrive preferences] hydrate failed', err);
      set({
        ...DEFAULT_APP_UI_STATE,
        firstRunMs: Date.now(),
        launchCount: 1,
        hydrated: true
      });
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
  setSeenFeedbackPrompt(value) {
    if (get().seenFeedbackPrompt === value) return;
    set({ seenFeedbackPrompt: value });
    scheduleSave(get);
  },
  setAutoUpdateOnLaunch(value) {
    if (get().autoUpdateOnLaunch === value) return;
    set({ autoUpdateOnLaunch: value });
    scheduleSave(get);
  },
  setTheme(value) {
    if (get().theme === value) return;
    set({ theme: value });
    scheduleSave(get);
  },
  setShowOutlineRail(value) {
    if (get().showOutlineRail === value) return;
    set({ showOutlineRail: value });
    scheduleSave(get);
  },
  setShowWordCount(value) {
    if (get().showWordCount === value) return;
    set({ showWordCount: value });
    scheduleSave(get);
  },
  setWordCountMetric(value) {
    if (get().wordCountMetric === value) return;
    set({ wordCountMetric: value });
    scheduleSave(get);
  },

  setLineMeasure(value) {
    if (get().lineMeasure === value) return;
    set({ lineMeasure: value });
    scheduleSave(get);
  },
  setSmartTypography(value) {
    if (get().smartTypography === value) return;
    set({ smartTypography: value });
    scheduleSave(get);
  },
  setFormatOnSave(value) {
    if (get().formatOnSave === value) return;
    set({ formatOnSave: value });
    scheduleSave(get);
  },
  setAutosaveIdleDelayMs(value) {
    // Clamp to the stepper's range so a malformed stored value or an
    // over-eager click can't push the autosave debounce out of bounds.
    const clamped = Math.min(
      AUTOSAVE_IDLE_MAX_MS,
      Math.max(AUTOSAVE_IDLE_MIN_MS, Math.round(value))
    );
    if (get().autosaveIdleDelayMs === clamped) return;
    set({ autosaveIdleDelayMs: clamped });
    scheduleSave(get);
  },
  setNewFileLocation(value) {
    if (get().newFileLocation === value) return;
    set({ newFileLocation: value });
    scheduleSave(get);
  },
  setNewFileNaming(value) {
    if (get().newFileNaming === value) return;
    set({ newFileNaming: value });
    scheduleSave(get);
  },
  setSlugFormat(value) {
    if (get().slugFormat === value) return;
    set({ slugFormat: value });
    scheduleSave(get);
  },
  setGitHistoryEnabled(value) {
    if (get().gitHistoryEnabled === value) return;
    set({ gitHistoryEnabled: value });
    scheduleSave(get);
  },
  setSeedFrontmatter(value) {
    if (get().seedFrontmatter === value) return;
    set({ seedFrontmatter: value });
    scheduleSave(get);
  },
  setFrontmatterFields(value) {
    set({ frontmatterFields: value });
    scheduleSave(get);
  },
  setDateFormat(value) {
    if (get().dateFormat === value) return;
    set({ dateFormat: value });
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
