// Phase 2 app shell: a single in-memory document with a three-mode
// editor surface. The chrome (real overlay title bar, panel toggles,
// tabs) ports in Phase 4 — this is just enough scaffolding to exercise
// the editor and preview against demo content during the migration.

import { useCallback, useEffect, useState } from 'react';
import { SplitView, type LayoutMode } from './components/editor/SplitView';
import { matchLayoutShortcut } from './components/editor/keys';

const DEMO_DOC = `# Skrive

A markdown editor for writers. **Local-first**, *offline*, ~~portable~~ portable plain text.

## What you're looking at

Phase 2 of the React + Electron migration: the editor surface, ported faithfully from the Svelte/Tauri build. Inline preview, three layout modes, the same theme.

The cursor reveals raw markup on its own line — try it. Move the cursor onto this line: **bold**, *italic*, ~~strikethrough~~, \`inline code\`, and [a link](https://example.com).

### Layout modes

Press \`⌘1\` for raw, \`⌘2\` for split, \`⌘3\` for preview. The mode persists for this session only at v0.2; per-file persistence wires through Phase 9.

## What's still ahead

- Project intelligence (Phase 3+): file tree, watcher, fs IPC
- Diff via napi-rs (Phase 5)
- Backlinks + link graph (Phase 6)
- Frontmatter (Phase 7)
- Lint (Phase 8)
- Settings + persistence (Phase 9)
- Search + history (Phase 10)
- Cmdk + chrome polish (Phase 11)
- A11y, perf, signing (Phase 12)

> Files are the source of truth. No database, no vault, no sync service. The filesystem is the data layer.
`;

const MODES: LayoutMode[] = ['raw', 'split', 'preview'];
const MODE_LABELS: Record<LayoutMode, string> = {
  raw: 'Raw',
  split: 'Split',
  preview: 'Preview'
};

export function App() {
  const [body, setBody] = useState(DEMO_DOC);
  const [mode, setMode] = useState<LayoutMode>('split');
  const [ratio, setRatio] = useState(0.5);

  // Window-level keyboard handler for ⌘1 / ⌘2 / ⌘3. Bound at the window
  // (not via CM6 keymap) so the shortcuts work regardless of whether the
  // editor or preview pane has focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const next = matchLayoutShortcut(e);
      if (!next) return;
      e.preventDefault();
      setMode(next);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleChange = useCallback((next: string) => {
    setBody(next);
  }, []);

  const handleRatioChange = useCallback((next: number) => {
    setRatio(next);
  }, []);

  return (
    <div className="app-root">
      <header className="app-titlebar">
        <div className="app-titlebar__modes" role="group" aria-label="Layout mode">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className="app-titlebar__mode"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </header>

      <main className="app-body">
        <SplitView
          mode={mode}
          ratio={ratio}
          body={body}
          onChange={handleChange}
          onRatioChange={handleRatioChange}
        />
      </main>
    </div>
  );
}
