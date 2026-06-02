// Phase 4 app shell: real overlay title bar (Header), Notion-style
// tabs, multi-tab editor surface with per-tab layout mode + split
// ratio. Toasts via sonner. Right-click context menus + delete-confirm
// modal land in Sidebar. Phase 9 wires per-project persistence.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { SplitView } from './components/editor/SplitView';
import { TextToolbar } from './components/editor/TextToolbar';
import { RichEditor } from './components/editor/rich/RichEditor';
import { flushActiveEditor } from './components/editor/active-editor';
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
import { logDuration, perfEnabled } from './lib/perf';

const SAVE_DEBOUNCE_MS = 500;

export function App() {
  const manifest = useProjectStore((s) => s.manifest);
  const activeTab = useProjectStore(selectActiveTab);
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const setTabBody = useProjectStore((s) => s.setTabBody);
  const setTabSplitRatio = useProjectStore((s) => s.setTabSplitRatio);
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
  const lintReport = useProjectStore((s) => s.lintReport);
  const setTabCursor = useProjectStore((s) => s.setTabCursor);
  const setTabScrollTop = useProjectStore((s) => s.setTabScrollTop);
  const clearPendingSelection = useProjectStore(
    (s) => s.clearPendingSelection
  );
  const persistProjectStateNow = useProjectStore(
    (s) => s.persistProjectStateNow
  );
  const openProject = useProjectStore((s) => s.openProject);
  const activeView = useProjectStore((s) => s.activeView);
  const theme = usePreferencesStore((s) => s.theme);
  const showOutlineRail = usePreferencesStore((s) => s.showOutlineRail);
  const defaultSurface = usePreferencesStore((s) => s.defaultSurface);
  const hydratePreferences = usePreferencesStore((s) => s.hydrate);
  const persistPreferencesNow = usePreferencesStore((s) => s.persistNow);
  const preferencesHydrated = usePreferencesStore((s) => s.hydrated);
  const lastOpenedProject = usePreferencesStore((s) => s.lastOpenedProject);
  const recentProjects = usePreferencesStore((s) => s.recentProjects);
  const removeRecentProject = usePreferencesStore(
    (s) => s.removeRecentProject
  );

  const activeLintFindings = useMemo(() => {
    if (!activeTab || !lintReport) return [];
    return lintReport.findings.filter((f) => f.path === activeTab.path);
  }, [activeTab, lintReport]);

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
  const launchUpdateRef = useRef(false);
  useEffect(() => {
    if (launchUpdateRef.current) return;
    if (!preferencesHydrated) return;
    launchUpdateRef.current = true;
    if (!usePreferencesStore.getState().autoUpdateOnLaunch) return;
    const seen = new Set<string>();
    const unsubscribe = window.skrive.updater.onStatus((status) => {
      if (status.kind !== 'available') return;
      if (seen.has(status.version)) return;
      seen.add(status.version);
      notify.prompt(
        `Skrive v${status.version} is available.`,
        'Open Settings',
        () => useProjectStore.getState().toggleSettings()
      );
    });
    void window.skrive.updater
      .check()
      .catch((err) => logProjectError('updater:launch-check', err));
    return unsubscribe;
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
      openNewProject: () => setNewProjectOpen(true)
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

  // Debounced auto-save flushes any dirty tabs.
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
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [dirtyTabHash, saveAllDirty]);

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
          <SettingsView appVersion={appVersion} />
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
              ) : activeTab && defaultSurface === 'rich' ? (
                <RichEditor
                  key={activeTab.path}
                  body={activeTab.body}
                  onChange={(next) => setTabBody(activeTabIndex, next)}
                />
              ) : activeTab ? (
                <>
                  <TextToolbar />
                  <SplitView
                    key={activeTab.path}
                    mode={activeTab.layoutMode}
                    ratio={activeTab.splitDividerRatio}
                    body={activeTab.body}
                    filePath={activeTab.path}
                    projectRoot={manifest.root}
                    onChange={(next) => setTabBody(activeTabIndex, next)}
                    onRatioChange={(next) =>
                      setTabSplitRatio(activeTabIndex, next)
                    }
                    lintFindings={activeLintFindings}
                    initialCursorLine={activeTab.cursorLine}
                    initialCursorColumn={activeTab.cursorColumn}
                    initialScrollTop={activeTab.scrollTop}
                    pendingSelection={activeTab.pendingSelection}
                    onPendingSelectionApplied={() =>
                      clearPendingSelection(activeTabIndex)
                    }
                    onCursorChange={(line, column) =>
                      setTabCursor(activeTabIndex, line, column)
                    }
                    onScrollTopChange={(top) =>
                      setTabScrollTop(activeTabIndex, top)
                    }
                    showOutlineRail={showOutlineRail}
                  />
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
            <p>A markdown editor for writers. Open a project to begin.</p>
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
              Or press <kbd>⌘O</kbd>.
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
    </div>
  );
}
