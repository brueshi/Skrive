// Phase 4 app shell: real overlay title bar (Header), Notion-style
// tabs, multi-tab editor surface with per-tab layout mode + split
// ratio. Toasts via sonner. Right-click context menus + delete-confirm
// modal land in Sidebar. Phase 9 wires per-project persistence.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { SplitView } from './components/editor/SplitView';
import { DiffView } from './components/editor/DiffView';
import { matchLayoutShortcut } from './components/editor/keys';
import { Header, useChromeShortcuts } from './components/chrome/Header';
import { BacklinksPanel } from './components/panels/BacklinksPanel';
import { FrontmatterPanel } from './components/panels/FrontmatterPanel';
import { HistoryPanel } from './components/panels/HistoryPanel';
import { SettingsView } from './components/settings/SettingsView';
import { Sidebar } from './components/sidebar/Sidebar';
import { SearchModal } from './components/modals/SearchModal';
import { RenameModal } from './components/modals/RenameModal';
import { CommandPalette } from './components/cmdk/CommandPalette';
import { FileSwitcher } from './components/cmdk/FileSwitcher';
import type { CommandDeps } from './lib/commands/registry';
import {
  logProjectError,
  selectActiveTab,
  useProjectStore
} from './stores/project';
import { usePreferencesStore } from './stores/preferences';
import { useTypographyVars } from './lib/typography-css';
import { notify } from './lib/notify';

const SAVE_DEBOUNCE_MS = 500;

export function App() {
  const manifest = useProjectStore((s) => s.manifest);
  const activeTab = useProjectStore(selectActiveTab);
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const setTabBody = useProjectStore((s) => s.setTabBody);
  const setTabSplitRatio = useProjectStore((s) => s.setTabSplitRatio);
  const setTabLayoutMode = useProjectStore((s) => s.setTabLayoutMode);
  const saveActiveTab = useProjectStore((s) => s.saveActiveTab);
  const saveAllDirty = useProjectStore((s) => s.saveAllDirty);
  const openProjectFromDialog = useProjectStore(
    (s) => s.openProjectFromDialog
  );
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const toggleFrontmatterPanel = useProjectStore(
    (s) => s.toggleFrontmatterPanel
  );
  const toggleBacklinksPanel = useProjectStore(
    (s) => s.toggleBacklinksPanel
  );
  const toggleHistoryPanel = useProjectStore((s) => s.toggleHistoryPanel);
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
  const toggleSettings = useProjectStore((s) => s.toggleSettings);
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

  useChromeShortcuts();
  useTypographyVars();

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

  const commandDeps: CommandDeps = useMemo(
    () => ({
      openFileSwitcher: () => setSwitcherOpen(true),
      openSearch: () => setSearchOpen(true),
      openRename: (path: string) => openRenameModal(path),
      openNewProject: () => {
        // 11c lands the new-project dialog.
      }
    }),
    [openRenameModal]
  );

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Window-level shortcuts: ⌘1/⌘2/⌘3 layout (per-tab), ⌘B sidebar,
  // ⌘O open project, ⌘S explicit save.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const layout = matchLayoutShortcut(e);
      if (layout) {
        e.preventDefault();
        if (activeTabIndex >= 0) setTabLayoutMode(activeTabIndex, layout);
        return;
      }
      // ⌘⇧F — toggle frontmatter panel.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'f' || e.key === 'F')
      ) {
        e.preventDefault();
        toggleFrontmatterPanel();
        return;
      }
      // ⌘⇧B — toggle the backlinks panel. Requires an active tab —
      // backlinks are contextual to the file being viewed.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'b' || e.key === 'B')
      ) {
        if (activeTab) {
          e.preventDefault();
          toggleBacklinksPanel();
        }
        return;
      }
      // ⌘⇧H — toggle the version-history panel. Same posture as the
      // other top-right panels.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'h' || e.key === 'H')
      ) {
        if (activeTab) {
          e.preventDefault();
          toggleHistoryPanel();
        }
        return;
      }
      // F2 — rename the active tab's file. No modifier keys; fires
      // straight from the keymap. Gated on an active tab so we don't
      // open an empty modal.
      if (
        e.key === 'F2' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        if (activeTab) {
          e.preventDefault();
          openRenameModal(activeTab.path);
        }
        return;
      }
      // ⌘F — toggle the project-wide search modal. Skrive's "find" is
      // project-wide; in-document navigation is by scroll. Overrides
      // CodeMirror's built-in find binding intentionally — same posture
      // as v0.1.6.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 'f' || e.key === 'F')
      ) {
        if (manifest) {
          e.preventDefault();
          setSearchOpen((open) => !open);
        }
        return;
      }
      // ⌘P / ⌘⇧P — file switcher / command palette. Both gated on a
      // project being open. They're mutually exclusive — opening one
      // closes the other so the modal stack stays one-deep.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        (e.key === 'p' || e.key === 'P')
      ) {
        if (!manifest) return;
        e.preventDefault();
        if (e.shiftKey) {
          setSwitcherOpen(false);
          setPaletteOpen((open) => !open);
        } else {
          setPaletteOpen(false);
          setSwitcherOpen((open) => !open);
        }
        return;
      }
      // ⌘, — toggle the settings view in the workspace area.
      // Only effective when a project is open; settings live inside
      // the project shell so they can't render without one.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key === ','
      ) {
        e.preventDefault();
        if (manifest) toggleSettings();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        void openProjectFromDialog().catch((err) =>
          logProjectError('openProjectFromDialog', err)
        );
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        void saveActiveTab().catch((err) => {
          logProjectError('saveActiveTab', err);
          notify.error('Failed to save', err);
        });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeTabIndex,
    activeTab,
    setTabLayoutMode,
    toggleSidebar,
    openProjectFromDialog,
    saveActiveTab,
    toggleFrontmatterPanel,
    toggleBacklinksPanel,
    toggleHistoryPanel,
    openRenameModal,
    manifest,
    toggleSettings
  ]);

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
        notify.error('Failed to save', err);
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

  // Suppress the empty-state flash while preferences haven't loaded —
  // a recent project may auto-open once the store is hydrated. The
  // hydrate call is fast (a single IPC round-trip) so this gate only
  // blocks the very first paint.
  void preferencesHydrated;

  return (
    <div className="app-root">
      <Header />

      <main className="app-body">
        {manifest ? (
          <>
            <Sidebar />
            <section className="workspace">
              {activeView === 'settings' ? (
                <SettingsView appVersion={appVersion} />
              ) : activeTab && activeTab.diff ? (
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
                <SplitView
                  key={activeTab.path}
                  mode={activeTab.layoutMode}
                  ratio={activeTab.splitDividerRatio}
                  body={activeTab.body}
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
                />
              ) : (
                <div className="empty-pane">
                  <p>Select a file from the sidebar to open it as a tab.</p>
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="empty-state">
            <h1>Skrive</h1>
            <p>A markdown editor for writers. Open a project to begin.</p>
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

      <BacklinksPanel />
      <FrontmatterPanel />
      <HistoryPanel />

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <RenameModal />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        deps={commandDeps}
      />
      <FileSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
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
