// Phase 4 app shell: real overlay title bar (Header), Notion-style
// tabs, multi-tab editor surface with per-tab layout mode + split
// ratio. Toasts via sonner. Right-click context menus + delete-confirm
// modal land in Sidebar. Phase 9 wires per-project persistence.

import { useEffect, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { SplitView } from './components/editor/SplitView';
import { DiffPlayground } from './components/editor/DiffPlayground';
import { matchLayoutShortcut } from './components/editor/keys';
import { Header, useChromeShortcuts } from './components/chrome/Header';
import { Sidebar } from './components/sidebar/Sidebar';
import {
  logProjectError,
  selectActiveTab,
  useProjectStore
} from './stores/project';
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

  useChromeShortcuts();

  // Phase 5 dev surface: ⌘⇧D toggles a diff playground overlay so the
  // new DiffView can be A/B'd against v0.1.6 before HistoryPanel wires
  // the real surface in Phase 10. Removed when HistoryPanel ships.
  const [diffPlaygroundOpen, setDiffPlaygroundOpen] = useState(false);

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
      // ⌘⇧D — toggle diff playground (Phase 5 dev surface).
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'd' || e.key === 'D')
      ) {
        e.preventDefault();
        setDiffPlaygroundOpen((open) => !open);
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
    setTabLayoutMode,
    toggleSidebar,
    openProjectFromDialog,
    saveActiveTab
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
  // closes are lost. Acceptable for v0.2; Phase 9 hardens this with
  // a synchronous-on-quit hook in the shell.
  useEffect(() => {
    function onBeforeUnload() {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void saveAllDirty().catch((err) => logProjectError('saveAllDirty', err));
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveAllDirty]);

  return (
    <div className="app-root">
      <Header />

      <main className="app-body">
        {manifest ? (
          <>
            <Sidebar />
            <section className="workspace">
              {activeTab ? (
                <SplitView
                  key={activeTab.path}
                  mode={activeTab.layoutMode}
                  ratio={activeTab.splitDividerRatio}
                  body={activeTab.body}
                  onChange={(next) => setTabBody(activeTabIndex, next)}
                  onRatioChange={(next) =>
                    setTabSplitRatio(activeTabIndex, next)
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
          </div>
        )}
      </main>

      {diffPlaygroundOpen && (
        <DiffPlayground onClose={() => setDiffPlaygroundOpen(false)} />
      )}

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
