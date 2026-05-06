// Phase 3 app shell: project sidebar + single-active-file editor.
//
// State model: one project at a time, one active file at a time. Tabs
// land in Phase 4 (chrome). On every body edit, a 500ms-debounced
// auto-save flushes to disk via fs:writeFile. ⌘S forces an immediate
// flush.
//
// Per-file mode + ratio persistence wires through Phase 9 — for now
// mode and split ratio are app-level (one value, applied to whichever
// file is active).

import { useCallback, useEffect, useRef, useState } from 'react';
import { SplitView, type LayoutMode } from './components/editor/SplitView';
import { matchLayoutShortcut } from './components/editor/keys';
import { Sidebar } from './components/sidebar/Sidebar';
import { useProjectStore, logProjectError } from './stores/project';

const SAVE_DEBOUNCE_MS = 500;

const EMPTY_PANE_HINT =
  'Select a file from the sidebar, or use ⌘O to open a different project.';

export function App() {
  const manifest = useProjectStore((s) => s.manifest);
  const activeFile = useProjectStore((s) => s.activeFile);
  const activeBody = useProjectStore((s) => s.activeBody);
  const activeDirty = useProjectStore((s) => s.activeDirty);
  const setBody = useProjectStore((s) => s.setBody);
  const saveActive = useProjectStore((s) => s.saveActive);
  const openProjectFromDialog = useProjectStore(
    (s) => s.openProjectFromDialog
  );
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);

  const [mode, setMode] = useState<LayoutMode>('split');
  const [ratio, setRatio] = useState(0.5);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Window-level shortcuts: ⌘1/⌘2/⌘3 layout, ⌘B sidebar, ⌘O open project,
  // ⌘S explicit save.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const layout = matchLayoutShortcut(e);
      if (layout) {
        e.preventDefault();
        setMode(layout);
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
        void saveActive().catch((err) => logProjectError('saveActive', err));
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar, openProjectFromDialog, saveActive]);

  // Debounced auto-save. Re-armed on every body edit.
  useEffect(() => {
    if (!activeDirty) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveActive().catch((err) => logProjectError('saveActive', err));
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [activeDirty, activeBody, saveActive]);

  // Save on unload — best-effort, the renderer can't await async.
  useEffect(() => {
    function onBeforeUnload() {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void saveActive().catch((err) => logProjectError('saveActive', err));
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveActive]);

  const handleChange = useCallback(
    (next: string) => setBody(next),
    [setBody]
  );

  return (
    <div className="app-root">
      <header className="app-titlebar">
        <div
          className="app-titlebar__modes"
          role="group"
          aria-label="Layout mode"
        >
          {(['raw', 'split', 'preview'] satisfies LayoutMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className="app-titlebar__mode"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {m === 'raw' ? 'Raw' : m === 'split' ? 'Split' : 'Preview'}
            </button>
          ))}
        </div>
      </header>

      <main className="app-body">
        {manifest ? (
          <>
            <Sidebar />
            <section className="workspace">
              {activeFile ? (
                <SplitView
                  key={activeFile.path}
                  mode={mode}
                  ratio={ratio}
                  body={activeBody}
                  onChange={handleChange}
                  onRatioChange={setRatio}
                />
              ) : (
                <div className="empty-pane">
                  <p>{EMPTY_PANE_HINT}</p>
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
    </div>
  );
}
