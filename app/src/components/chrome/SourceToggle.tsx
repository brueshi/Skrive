// Rendered | Source view toggle for the topbar trio (SKR-97). Flips the active
// tab's in-memory `rawView`, which App.tsx reads to render either the bespoke
// block surface or the raw Markdown source view over the same buffer. Inherits
// the slot and chip-segmented styling of the retired Rich/Text SurfaceToggle.
//
// Flushes the active surface before switching so a pending debounced snapshot
// (block surface or raw textarea) lands in the store first — the newly mounted
// view then reads the up-to-date body.

import { flushActiveEditor } from '../editor/active-editor';
import { selectActiveTab, useProjectStore } from '../../stores/project';

const OPTIONS: { raw: boolean; label: string }[] = [
  { raw: false, label: 'Rendered' },
  { raw: true, label: 'Source' }
];

export function SourceToggle() {
  const activeTab = useProjectStore(selectActiveTab);
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const setTabRawView = useProjectStore((s) => s.setTabRawView);

  if (!activeTab) return null;
  const rawView = activeTab.rawView;

  function select(raw: boolean) {
    if (rawView === raw) return;
    flushActiveEditor();
    setTabRawView(activeTabIndex, raw);
  }

  return (
    <div className="chip-segmented" role="radiogroup" aria-label="Document view">
      {OPTIONS.map((opt) => (
        <button
          key={opt.label}
          type="button"
          role="radio"
          aria-checked={rawView === opt.raw}
          className={`chip-segmented-option${
            rawView === opt.raw ? ' active' : ''
          }`}
          onClick={() => select(opt.raw)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
