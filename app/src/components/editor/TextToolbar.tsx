// The Text-surface toolbar (Stage 2). A divided bar above the Text
// (CodeMirror / SplitView) surface, mirroring the Rich surface's own
// toolbar. It carries the controls that are specific to editing Markdown
// source:
//   - the Editor / Split / Preview layout control, relocated here out of
//     the topbar (the Rich surface has no layout modes, so it never
//     belonged in the global chrome);
//   - the marker-mode pill (Raw / Recessed / Concealed), dimmed in
//     preview-only mode where no editor is visible;
//   - a live word count.
//
// Reads the active tab + marker pref directly from the stores, like the
// layout control it absorbs.

import { selectActiveTab, useProjectStore } from '../../stores/project';
import { usePreferencesStore } from '../../stores/preferences';
import type { MarkerMode } from '@skrive/shared';
import { ModeToggle } from '../chrome/ModeToggle';

const MARKER_OPTIONS: { id: MarkerMode; label: string }[] = [
  { id: 'raw', label: 'Raw' },
  { id: 'recessed', label: 'Recessed' },
  { id: 'concealed', label: 'Concealed' }
];

/** Words in the body, ignoring a leading YAML frontmatter block so the
 *  count reflects prose rather than metadata. */
function countWords(body: string): number {
  const prose = body.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const matches = prose.match(/\S+/g);
  return matches ? matches.length : 0;
}

export function TextToolbar() {
  const activeTab = useProjectStore(selectActiveTab);
  const markerMode = usePreferencesStore((s) => s.markerMode);
  const setMarkerMode = usePreferencesStore((s) => s.setMarkerMode);

  // DiffView carries its own chrome; no document toolbar over it.
  if (!activeTab || activeTab.diff) return null;

  // Marker treatment only shows where an editor pane is visible.
  const markerDimmed = activeTab.layoutMode === 'preview';
  const words = countWords(activeTab.body);

  return (
    <div className="text-toolbar">
      <div className="text-toolbar-inner">
        <ModeToggle />

        <div
          className={`chip-segmented marker-pill${
            markerDimmed ? ' is-dimmed' : ''
          }`}
          role="radiogroup"
          aria-label="Markdown marker mode"
        >
          {MARKER_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={markerMode === opt.id}
              className={`chip-segmented-option${
                markerMode === opt.id ? ' active' : ''
              }`}
              onClick={() => setMarkerMode(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <span className="text-toolbar-count">
          {words.toLocaleString()} {words === 1 ? 'word' : 'words'}
        </span>
      </div>
    </div>
  );
}
