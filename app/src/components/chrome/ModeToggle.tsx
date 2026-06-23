// Raw / Split / Preview segmented control. Lives in the Text-surface
// toolbar (TextToolbar) — it's specific to editing Markdown source, so
// it was relocated out of the global topbar in the 1.0 build. Hidden
// while the active tab is showing a diff — DiffView carries its own
// mode toggle.

import { selectActiveTab, useProjectStore } from '../../stores/project';
import { IconLayoutPreview } from '../icons/IconLayoutPreview';
import { IconLayoutRaw } from '../icons/IconLayoutRaw';
import { IconLayoutSplit } from '../icons/IconLayoutSplit';
import { platformShortcut } from '../../lib/commands/shortcut-display';
import type { LayoutMode } from '../editor/SplitView';

export function ModeToggle() {
  const activeTab = useProjectStore(selectActiveTab);
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const setTabLayoutMode = useProjectStore((s) => s.setTabLayoutMode);

  if (!activeTab || activeTab.diff) return null;

  function setMode(mode: LayoutMode) {
    if (activeTabIndex < 0) return;
    setTabLayoutMode(activeTabIndex, mode);
  }

  function isMode(mode: LayoutMode): boolean {
    return activeTab?.layoutMode === mode;
  }

  return (
    <div className="mode-toggle" role="group" aria-label="Layout mode">
      <button
        type="button"
        className={`mode-button${isMode('raw') ? ' active' : ''}`}
        aria-pressed={isMode('raw')}
        title={platformShortcut('Raw  ⌘1')}
        onClick={() => setMode('raw')}
      >
        <IconLayoutRaw size={16} />
      </button>
      <button
        type="button"
        className={`mode-button${isMode('split') ? ' active' : ''}`}
        aria-pressed={isMode('split')}
        title={platformShortcut('Split  ⌘2')}
        onClick={() => setMode('split')}
      >
        <IconLayoutSplit size={16} />
      </button>
      <button
        type="button"
        className={`mode-button${isMode('preview') ? ' active' : ''}`}
        aria-pressed={isMode('preview')}
        title={platformShortcut('Preview  ⌘3')}
        onClick={() => setMode('preview')}
      >
        <IconLayoutPreview size={16} />
      </button>
    </div>
  );
}
