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
  type DailyNoteFormat,
  type EditorFontId,
  clampLineMeasureCh,
  type LineMeasureSetting,
  type RecentProject,
  type ThemeId,
  type WordCountMetric
} from '@skrive/shared';

const SAVE_DEBOUNCE_MS = 300;

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

  setLineMeasure(value: LineMeasureSetting): void;
  /** Set the custom column width (clamped, whole ch) and make it the
   *  active measure — adjusting the number IS choosing Custom. */
  setLineMeasureCustomCh(value: number): void;
  setShowMeasureRule(value: boolean): void;
  setSmartTypography(value: boolean): void;
  /** Turn the writing surface's spellchecking on or off. */
  setSpellcheck(value: boolean): void;
  setFormatOnSave(value: boolean): void;
  setAutosaveIdleDelayMs(value: number): void;
  /** Persist the git-history preference. Pure: it only stores the value.
   *  Project-side coordination (pushing it to the shell and refreshing the
   *  open project's history) lives in the project store's action of the
   *  same name, which calls this. */
  setGitHistoryEnabled(value: boolean): void;
  setDailyNotesFormat(value: DailyNoteFormat): void;
  setDailyNotesFolder(value: string): void;
  setDailyNotesDateFormat(value: string): void;
  setDailyNotesTemplate(value: string): void;

  addDictionaryWord(word: string): void;
  removeDictionaryWord(word: string): void;

  setLastOpenedProject(path: string | null): void;
  recordRecentProject(path: string, name: string): void;
  removeRecentProject(path: string): void;

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
    // Legacy since SKR-243 Stage 2: the recent-files LRU is no longer
    // written (the desk + ⌘P switcher read the working set instead). The
    // persisted field is kept and round-tripped verbatim for cross-shell
    // stability — an older shell reading this state still finds it intact
    // (the LayoutMode precedent).
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
    lineMeasureCustomCh: state.lineMeasureCustomCh,
    showMeasureRule: state.showMeasureRule,
    smartTypography: state.smartTypography,
    spellcheck: state.spellcheck,
    formatOnSave: state.formatOnSave,
    autosaveIdleDelayMs: state.autosaveIdleDelayMs,
    newFileLocation: state.newFileLocation,
    newFileNaming: state.newFileNaming,
    slugFormat: state.slugFormat,
    gitHistoryEnabled: state.gitHistoryEnabled,
    seedFrontmatter: state.seedFrontmatter,
    frontmatterFields: state.frontmatterFields,
    dateFormat: state.dateFormat,
    dailyNotesFormat: state.dailyNotesFormat,
    dailyNotesFolder: state.dailyNotesFolder,
    dailyNotesDateFormat: state.dailyNotesDateFormat,
    dailyNotesTemplate: state.dailyNotesTemplate
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
  setLineMeasureCustomCh(value) {
    const clamped = clampLineMeasureCh(value);
    const s = get();
    if (s.lineMeasureCustomCh === clamped && s.lineMeasure === 'custom') {
      return;
    }
    set({ lineMeasureCustomCh: clamped, lineMeasure: 'custom' });
    scheduleSave(get);
  },
  setShowMeasureRule(value) {
    if (get().showMeasureRule === value) return;
    set({ showMeasureRule: value });
    scheduleSave(get);
  },
  setSmartTypography(value) {
    if (get().smartTypography === value) return;
    set({ smartTypography: value });
    scheduleSave(get);
  },
  setSpellcheck(value) {
    if (get().spellcheck === value) return;
    set({ spellcheck: value });
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
  setGitHistoryEnabled(value) {
    if (get().gitHistoryEnabled === value) return;
    set({ gitHistoryEnabled: value });
    scheduleSave(get);
  },
  setDailyNotesFormat(value) {
    if (get().dailyNotesFormat === value) return;
    set({ dailyNotesFormat: value });
    scheduleSave(get);
  },
  setDailyNotesFolder(value) {
    if (get().dailyNotesFolder === value) return;
    set({ dailyNotesFolder: value });
    scheduleSave(get);
  },
  setDailyNotesDateFormat(value) {
    if (get().dailyNotesDateFormat === value) return;
    set({ dailyNotesDateFormat: value });
    scheduleSave(get);
  },
  setDailyNotesTemplate(value) {
    if (get().dailyNotesTemplate === value) return;
    set({ dailyNotesTemplate: value });
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
