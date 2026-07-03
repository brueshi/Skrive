// Phase 4 app shell: real overlay title bar (Header), Notion-style
// tabs, multi-tab editor surface with per-tab layout mode + split
// ratio. Toasts via sonner. Right-click context menus + delete-confirm
// modal land in Sidebar. Phase 9 wires per-project persistence.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { BlockEditor } from './components/editor/block/BlockEditor';
import { MarkdownView } from './components/editor/markdown/MarkdownView';
import { EditorBar } from './components/editor/EditorBar';
import { flushActiveEditor } from './components/editor/active-editor';
import { installPasteCapture } from './lib/clipboard/capturePaste';
import { platformShortcut } from './lib/commands/shortcut-display';
import { DiffView } from './components/editor/DiffView';
import { Header } from './components/chrome/Header';
import { BacklinksPanel } from './components/panels/BacklinksPanel';
import { FrontmatterPanel } from './components/panels/FrontmatterPanel';
import { HistoryPanel } from './components/panels/HistoryPanel';
import { SettingsView } from './components/settings/SettingsView';
import { Sidebar } from './components/sidebar/Sidebar';
import { SearchModal } from './components/modals/SearchModal';
import { RenameModal } from './components/modals/RenameModal';
import { NewProjectDialog } from './components/modals/NewProjectDialog';
import { ReportDialog } from './components/modals/ReportDialog';
import type { ReportType } from './lib/report';
import { CheatSheetModal } from './components/modals/CheatSheetModal';
import { CommandPalette } from './components/cmdk/CommandPalette';
import { FileSwitcher } from './components/cmdk/FileSwitcher';
import {
  buildRegistry,
  dispatchKey,
  type CommandDeps
} from './lib/commands/registry';
import {
  logProjectError,
  selectActiveTab,
  useProjectStore
} from './stores/project';
import { usePreferencesStore } from './stores/preferences';
import { useTypographyVars } from './lib/typography-css';
import { notify } from './lib/notify';
import { openFeedbackForm } from './lib/feedback';
import { logDuration, perfEnabled } from './lib/perf';
import { enableLatencyProbe, LatencyOverlay } from './lib/instrumentation';

// One-time feedback nudge. Surfaces once the writer has opened Skrive
// enough times to have an opinion worth sharing — not on first run, when
// they've seen nothing yet. Shown exactly once (see seenFeedbackPrompt).
// The form URL + opener live in lib/feedback (also used by Settings).
const FEEDBACK_PROMPT_MIN_LAUNCHES = 3;
// Hold off a beat after boot so the toast doesn't slam in over the
// startup render / auto-opened project.
const FEEDBACK_PROMPT_DELAY_MS = 2500;

// Stage 6 graduation (M4a): the Electron build is on a sunset path. Its
// auto-updater can't cross to the new native (Zig-shell) app — a different
// artifact — so we notify-and-redownload: a toast that links to the download
// page, shown until the writer follows it. Electron-only (the native shells
// gate out via __SKRIVE_NATIVE_SHELL__). The "followed it" bit lives in
// localStorage, NOT AppUiState, so the cross-shell persistence schema (and its
// parity corpus + the Zig core default) stays untouched. NOTE: this URL must
// resolve to the native build before the toast-bearing release ships — it is
// repointed as part of the website makeover; until then, swap it for the
// GitHub Releases URL.
const MIGRATION_DOWNLOAD_URL = 'https://skrive.md/download';
const MIGRATION_ACTIONED_KEY = 'skrive.migrationActioned';
const MIGRATION_PROMPT_DELAY_MS = 2500;

export function App() {
  const manifest = useProjectStore((s) => s.manifest);
  const activeTab = useProjectStore(selectActiveTab);
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const setTabBody = useProjectStore((s) => s.setTabBody);
  const setTabModel = useProjectStore((s) => s.setTabModel);
  const setTabSplitDividerRatio = useProjectStore(
    (s) => s.setTabSplitDividerRatio
  );
  const saveAllDirty = useProjectStore((s) => s.saveAllDirty);
  const openProjectFromDialog = useProjectStore(
    (s) => s.openProjectFromDialog
  );
  const setTabDiffMode = useProjectStore((s) => s.setTabDiffMode);
  const setTabDiffDividerRatio = useProjectStore(
    (s) => s.setTabDiffDividerRatio
  );
  const closeDiff = useProjectStore((s) => s.closeDiff);
  const openRenameModal = useProjectStore((s) => s.openRenameModal);
  const persistProjectStateNow = useProjectStore(
    (s) => s.persistProjectStateNow
  );
  const openProject = useProjectStore((s) => s.openProject);
  const activeView = useProjectStore((s) => s.activeView);
  const theme = usePreferencesStore((s) => s.theme);
  const autosaveIdleDelayMs = usePreferencesStore((s) => s.autosaveIdleDelayMs);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  const persistPreferencesNow = usePreferencesStore((s) => s.persistNow);
  const preferencesHydrated = usePreferencesStore((s) => s.hydrated);
  const lastOpenedProject = usePreferencesStore((s) => s.lastOpenedProject);
  const recentProjects = usePreferencesStore((s) => s.recentProjects);
  const removeRecentProject = usePreferencesStore(
    (s) => s.removeRecentProject
  );

  useTypographyVars();

  // Theme. 'system' clears data-theme so the CSS color-scheme: light dark
  // declaration follows the OS via prefers-color-scheme. 'light' / 'dark'
  // pin color-scheme explicitly; the light-dark() tokens in :root pick up
  // the override automatically.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  // Phase-12b cold-open measurement. Logs the time from React mount
  // (recorded in main.tsx via window.__skriveMountStart) to the first
  // render where `manifest` is non-null — i.e. an auto-opened project
  // is loaded and ready to write into. Logs once per cold start.
  // SKR-108 Stage 0: attach the keystroke→paint probe at the document level so
  // it covers every editor surface (Rich, Text, and the future bespoke one)
  // with no per-surface wiring. Behind the same perf flag — no listener in a
  // normal session. The matching live readout is rendered below.
  useEffect(() => {
    if (!perfEnabled) return;
    const probe = enableLatencyProbe();
    return () => probe.stop();
  }, []);

  // DEV-only paste-capture harness (SKR-119 scaffolding). Inert until enabled
  // via __skriveCapturePaste.on() in the console; snapshots the raw clipboard
  // so paste fixtures come from real sources. See lib/clipboard/capturePaste.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return installPasteCapture();
  }, []);

  const coldOpenLoggedRef = useRef(false);
  useEffect(() => {
    if (!perfEnabled) return;
    if (coldOpenLoggedRef.current) return;
    if (!manifest) return;
    const start = (window as unknown as { __skriveMountStart?: number })
      .__skriveMountStart;
    if (typeof start !== 'number') return;
    coldOpenLoggedRef.current = true;
    logDuration(
      `cold-open (manifest with ${manifest.files.length} files)`,
      start
    );
  }, [manifest]);

  const [appVersion, setAppVersion] = useState('0.0.0');

  // Boot: hydrate preferences and read the app version from the shell
  // exactly once. Both are fire-and-forget — failure is logged, not
  // surfaced; the UI runs on defaults rather than blocking.
  useEffect(() => {
    void hydratePreferences();
    window.skrive.app
      .version()
      .then((v) => setAppVersion(v))
      .catch((err) => logProjectError('app:version', err));
  }, [hydratePreferences]);

  // Silent updater check on launch when the preference is on. The
  // shell short-circuits to 'no-update' in dev (!app.isPackaged) so
  // this stays quiet during development. Only an `available`
  // transition surfaces — as a sonner prompt that links to Settings.
  // Subsequent transitions (download progress, ready, error) flow
  // through the Settings UI's own subscription; we don't double-toast.
  const launchCheckRef = useRef(false);
  useEffect(() => {
    if (!preferencesHydrated) return;
    // Shells that own their own update UI (WinSparkle) opt out via this flag.
    // The macOS Zig host drives the contract UI instead, so it leaves the flag
    // unset and we surface updates here.
    if (window.__SKRIVE_NATIVE_UPDATER__ === true) return;

    // Surface `available` / `ready` as actionable toasts regardless of the
    // launch-check preference — a background check (Sparkle's own schedule) can
    // find an update too. The toast carries the next action inline (Download /
    // Restart); dismissing it is "Later". Deduped per version so a re-emitted
    // status (e.g. progress ticks resolving back to ready) doesn't re-toast.
    const toasted = new Set<string>();
    // Clicking a card opens Settings > Updates, where the explicit Download /
    // Restart controls live — keeping the toast itself button-free.
    const openUpdates = () => {
      const store = useProjectStore.getState();
      if (store.activeView !== 'settings') store.toggleSettings();
    };
    const unsubscribe = window.skrive.updater.onStatus((status) => {
      if (status.kind === 'available' && !toasted.has(`a:${status.version}`)) {
        toasted.add(`a:${status.version}`);
        notify.card('Update available', `Skrive ${status.version}`, openUpdates);
      } else if (status.kind === 'ready' && !toasted.has(`r:${status.version}`)) {
        toasted.add(`r:${status.version}`);
        notify.card('Ready to install', `Skrive ${status.version}`, openUpdates);
      }
    });

    // The launch-time check itself stays opt-in (fires once).
    if (!launchCheckRef.current && usePreferencesStore.getState().autoUpdateOnLaunch) {
      launchCheckRef.current = true;
      void window.skrive.updater
        .check()
        .catch((err) => logProjectError('updater:launch-check', err));
    }
    return unsubscribe;
  }, [preferencesHydrated]);

  // One-time feedback nudge. Fires once the launch counter crosses the
  // threshold and the writer hasn't seen it before; marks it seen on
  // display so it never returns. Mirrors the updater's notify.prompt
  // pattern — a persistent CTA that opens the form in the OS browser.
  const feedbackPromptRef = useRef(false);
  useEffect(() => {
    if (feedbackPromptRef.current) return;
    if (!preferencesHydrated) return;
    const prefs = usePreferencesStore.getState();
    if (prefs.seenFeedbackPrompt) return;
    if (prefs.launchCount < FEEDBACK_PROMPT_MIN_LAUNCHES) return;
    feedbackPromptRef.current = true;
    const timer = setTimeout(() => {
      usePreferencesStore.getState().setSeenFeedbackPrompt(true);
      notify.prompt(
        "How's Skrive treating you? We'd love to hear what you think.",
        'Share feedback',
        () => openFeedbackForm()
      );
    }, FEEDBACK_PROMPT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [preferencesHydrated]);

  // Graduation notice (M4a): point Electron users at the new native build.
  // Shown once per launch until followed; dismissing it (the X) lets it return
  // next launch so the migration isn't silently lost. No-op on the native
  // shells (they ARE the destination) and once the writer has followed it.
  //
  // Gate on __SKRIVE_NATIVE_SHELL__, NOT __SKRIVE_NATIVE_UPDATER__: the latter
  // tracks who owns the updater UI and is deliberately `false` on the macOS
  // native shell (it drives the contract UI itself), so reusing it here leaked
  // this Electron-only notice onto the native macOS app (SKR-121).
  const migrationPromptRef = useRef(false);
  useEffect(() => {
    if (migrationPromptRef.current) return;
    if (!preferencesHydrated) return;
    migrationPromptRef.current = true;
    if (window.__SKRIVE_NATIVE_SHELL__ === true) return;
    try {
      if (localStorage.getItem(MIGRATION_ACTIONED_KEY) === '1') return;
    } catch {
      // localStorage unavailable — fall through and show it anyway (surfacing
      // the migration matters more than de-duping it).
    }
    const timer = setTimeout(() => {
      notify.prompt(
        "Skrive has moved to a new, faster app — this version won't get future updates.",
        'Download the new Skrive',
        () => {
          try {
            localStorage.setItem(MIGRATION_ACTIONED_KEY, '1');
          } catch {
            // ignore — worst case the notice returns next launch
          }
          void window.skrive.links
            .openExternal(MIGRATION_DOWNLOAD_URL)
            .catch((err) => logProjectError('migration:open', err));
        }
      );
    }, MIGRATION_PROMPT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [preferencesHydrated]);

  // Auto-open the last project once preferences hydrate. Skipped if
  // a project is already loaded (defensive — first render might race
  // a manual openProject from the URL handler we don't have yet).
  const didAutoOpenRef = useRef(false);
  useEffect(() => {
    if (didAutoOpenRef.current) return;
    if (!preferencesHydrated) return;
    if (manifest) {
      didAutoOpenRef.current = true;
      return;
    }
    if (!lastOpenedProject) {
      didAutoOpenRef.current = true;
      return;
    }
    didAutoOpenRef.current = true;
    void openProject(lastOpenedProject).catch((err) => {
      logProjectError('auto-open lastOpenedProject', err);
      // The path may have moved; clear it so we don't retry every boot.
      usePreferencesStore.getState().setLastOpenedProject(null);
    });
  }, [preferencesHydrated, manifest, lastOpenedProject, openProject]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  const [report, setReport] = useState<{ open: boolean; kind: ReportType }>({
    open: false,
    kind: 'bug'
  });

  // Toggle helpers honour mutual exclusion: opening one cmdk-class
  // modal closes its sibling so the modal stack stays one-deep.
  // Pre-13a these closures lived inline in the giant App-level keydown
  // switch; they're hoisted into deps so the central registry can
  // call them directly.
  const commandDeps: CommandDeps = useMemo(
    () => ({
      toggleFileSwitcher: () => {
        setPaletteOpen(false);
        setSwitcherOpen((o) => !o);
      },
      toggleCommandPalette: () => {
        setSwitcherOpen(false);
        setPaletteOpen((o) => !o);
      },
      toggleSearch: () => setSearchOpen((o) => !o),
      toggleCheatSheet: () => setCheatSheetOpen((o) => !o),
      openRename: (path: string) => openRenameModal(path),
      openNewProject: () => setNewProjectOpen(true),
      openBugReport: () => setReport({ open: true, kind: 'bug' }),
      openFeedback: () => setReport({ open: true, kind: 'feedback' })
    }),
    [openRenameModal]
  );

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel the auto-save debounce when the user fires ⌘S explicitly —
  // the binding's own save covers it. Captured in a ref so the
  // registry binding can reach it without remounting on every render.
  const cancelSaveTimerRef = useRef(() => {});
  useEffect(() => {
    cancelSaveTimerRef.current = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  // Single window-level keydown listener. Reads from the registry's
  // bindings table. The 200-line per-binding switch this replaced
  // lived here through phase 11 — see planning/react-electron-phase-13-audit.md.
  const { bindings } = useMemo(() => buildRegistry(commandDeps), [commandDeps]);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // ⌘S has side-effects the registry runner doesn't know about: cancel
      // the auto-save debounce, and drain the editor's pending debounced
      // snapshot into the store so the save writes the latest bytes, not what
      // the surface last synced. The registry's run() then performs the save.
      if (
        e.code === 'KeyS' &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey
      ) {
        cancelSaveTimerRef.current();
        flushActiveEditor();
      }
      dispatchKey(e, bindings);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bindings]);

  // Debounced auto-save flushes any dirty tabs after the writer pauses.
  // The idle delay is the autosaveIdleDelayMs preference; ⌘S still forces
  // an immediate save independent of this timer.
  const dirtyTabHash = useProjectStore((s) =>
    s.tabs.map((t) => `${t.path}:${t.dirty ? '1' : '0'}`).join('|')
  );
  useEffect(() => {
    if (!dirtyTabHash.includes(':1')) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveAllDirty().catch((err) => {
        logProjectError('saveAllDirty', err);
        notify.error("Couldn't save", err);
      });
    }, autosaveIdleDelayMs);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [dirtyTabHash, saveAllDirty, autosaveIdleDelayMs]);

  // Best-effort save on unload — beforeunload can't await async, so
  // pending writes that haven't completed by the time the renderer
  // closes are lost. We still flush dirty tabs, project state, and
  // any pending preferences debounce; all best-effort.
  useEffect(() => {
    function onBeforeUnload() {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void saveAllDirty().catch((err) => logProjectError('saveAllDirty', err));
      void persistProjectStateNow().catch((err) =>
        logProjectError('persistProjectStateNow', err)
      );
      void persistPreferencesNow().catch((err) =>
        logProjectError('persistPreferencesNow', err)
      );
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveAllDirty, persistProjectStateNow, persistPreferencesNow]);

  // Pre-quit flush. Unlike beforeunload, this can await: main pauses the quit
  // until we ack. We drain the Rich surface's pending PM->text snapshot into the
  // store first, then write everything, so quitting mid-debounce never loses the
  // last edits.
  useEffect(() => {
    return window.skrive.app.onFlushBeforeQuit(() => {
      void (async () => {
        try {
          flushActiveEditor();
          if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          }
          await saveAllDirty();
          await persistProjectStateNow();
          await persistPreferencesNow();
        } catch (err) {
          logProjectError('flush-before-quit', err);
        } finally {
          window.skrive.app.flushComplete();
        }
      })();
    });
  }, [saveAllDirty, persistProjectStateNow, persistPreferencesNow]);

  // Suppress the empty-state flash while preferences haven't loaded —
  // a recent project may auto-open once the store is hydrated. The
  // hydrate call is fast (a single IPC round-trip) so this gate only
  // blocks the very first paint.
  void preferencesHydrated;

  return (
    <div className="app-root">
      <Header />

      <main className="app-body">
        {activeView === 'settings' ? (
          <SettingsView
            appVersion={appVersion}
            onReportBug={() => setReport({ open: true, kind: 'bug' })}
            onSendFeedback={() => setReport({ open: true, kind: 'feedback' })}
          />
        ) : manifest ? (
          <>
            <Sidebar />
            <section className="workspace">
              {activeTab && activeTab.diff ? (
                <DiffView
                  mode={activeTab.diff.diffMode}
                  before={{
                    label: activeTab.diff.before.label,
                    timestampMs: activeTab.diff.before.timestampMs
                  }}
                  after={{
                    label: activeTab.diff.after.label,
                    timestampMs: activeTab.diff.after.timestampMs
                  }}
                  dividerRatio={activeTab.diff.dividerRatio}
                  rows={activeTab.diff.rows}
                  onModeChange={(mode) => setTabDiffMode(activeTabIndex, mode)}
                  onDividerChange={(ratio) =>
                    setTabDiffDividerRatio(activeTabIndex, ratio)
                  }
                  onClose={closeDiff}
                />
              ) : activeTab ? (
                // Both editors share the persistent toolbar band (EditorBar,
                // SKR-123); the surface below it switches on the tab's mode
                // (rich `.folio` vs Markdown). Diff is a separate takeover with
                // its own chrome, so it sits outside the band (handled above).
                <>
                  <EditorBar />
                  <div className="workspace-surface">
                    {activeTab.mode === 'rich' && activeTab.model ? (
                      // Rich (`.folio`) mode: the block model is canonical. The
                      // surface edits it directly and saves the native format —
                      // no Markdown serializer on this path (SKR-196).
                      <BlockEditor
                        key={activeTab.path}
                        doc={activeTab.model}
                        onChange={(doc) => setTabModel(activeTabIndex, doc)}
                      />
                    ) : (
                      // Markdown source mode (SKR-197): edit raw text, see a
                      // rendered preview (raw / split / preview by layoutMode).
                      // Save is text -> text; the block model never touches `.md`.
                      // Keyed per file (uncontrolled).
                      <MarkdownView
                        key={activeTab.path}
                        body={activeTab.body}
                        onChange={(next) => setTabBody(activeTabIndex, next)}
                        filePath={activeTab.path}
                        projectRoot={manifest?.root ?? ''}
                        layoutMode={activeTab.layoutMode}
                        splitRatio={activeTab.splitDividerRatio}
                        onSplitRatioChange={(r) =>
                          setTabSplitDividerRatio(activeTabIndex, r)
                        }
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-pane">
                  <p>Select a file from the sidebar to open it as a tab.</p>
                </div>
              )}
            </section>
            <BacklinksPanel />
            <FrontmatterPanel />
            <HistoryPanel />
          </>
        ) : (
          <div className="empty-state">
            <h1>Skrive</h1>
            <p>A writing app for notes, drafts, and documents. Open a project to begin.</p>
            <div className="empty-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void openProjectFromDialog().catch((err) =>
                    logProjectError('openProjectFromDialog', err)
                  );
                }}
              >
                Open project…
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setNewProjectOpen(true)}
              >
                New project…
              </button>
            </div>
            <p className="hint">
              Or press <kbd>{platformShortcut('⌘O')}</kbd>.
            </p>
            {recentProjects.length > 0 && (
              <div className="empty-recent">
                <h2>Recent projects</h2>
                <ul className="empty-recent-list">
                  {recentProjects.map((rp) => (
                    <li key={rp.path} className="empty-recent-row">
                      <button
                        type="button"
                        className="empty-recent-button"
                        onClick={() =>
                          void openProject(rp.path).catch((err) => {
                            logProjectError('openProject (recent)', err);
                            notify.error(
                              `Couldn't open ${rp.name}`,
                              err
                            );
                            removeRecentProject(rp.path);
                          })
                        }
                        title={rp.path}
                      >
                        <span className="empty-recent-name">{rp.name}</span>
                        <span className="empty-recent-path">{rp.path}</span>
                      </button>
                      <button
                        type="button"
                        className="empty-recent-remove"
                        aria-label={`Remove ${rp.name} from recents`}
                        title="Remove from recents"
                        onClick={() => removeRecentProject(rp.path)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </main>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <RenameModal />
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
      />
      <ReportDialog
        open={report.open}
        kind={report.kind}
        onClose={() => setReport((r) => ({ ...r, open: false }))}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        deps={commandDeps}
      />
      <FileSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
      />
      <CheatSheetModal
        open={cheatSheetOpen}
        onClose={() => setCheatSheetOpen(false)}
        bindings={bindings}
      />
      <Toaster
        position="bottom-right"
        theme="dark"
        toastOptions={{
          style: {
            background: 'var(--skrive-bg)',
            color: 'var(--skrive-fg)',
            border: '1px solid var(--skrive-rule)',
            fontFamily: 'var(--skrive-ui-font)'
          }
        }}
      />
      {perfEnabled && <LatencyOverlay />}
    </div>
  );
}
