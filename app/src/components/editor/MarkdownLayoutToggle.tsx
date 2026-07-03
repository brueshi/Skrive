// Markdown source-mode layout switch (SKR-197). A three-way segmented control —
// source / split / preview — shown in the EditorBar only when the active tab is a
// Markdown file. `.folio` rich tabs have a single editing surface and no toggle.

import { useProjectStore } from '../../stores/project';
import type { LayoutMode } from '@skrive/shared';
import { IconLayoutRaw } from '../icons/IconLayoutRaw';
import { IconLayoutSplit } from '../icons/IconLayoutSplit';
import { IconLayoutPreview } from '../icons/IconLayoutPreview';

const MODES: ReadonlyArray<{
  mode: LayoutMode;
  label: string;
  Icon: typeof IconLayoutSplit;
}> = [
  { mode: 'raw', label: 'Source', Icon: IconLayoutRaw },
  { mode: 'split', label: 'Split', Icon: IconLayoutSplit },
  { mode: 'preview', label: 'Preview', Icon: IconLayoutPreview }
];

export function MarkdownLayoutToggle() {
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const tab = useProjectStore((s) => s.tabs[s.activeTabIndex]);
  const setTabLayoutMode = useProjectStore((s) => s.setTabLayoutMode);

  if (!tab || tab.mode !== 'markdown') return null;

  return (
    <div className="md-layout-toggle" role="group" aria-label="Editor layout">
      {MODES.map(({ mode, label, Icon }) => {
        const active = tab.layoutMode === mode;
        return (
          <button
            key={mode}
            type="button"
            className={`md-layout-btn${active ? ' active' : ''}`}
            aria-pressed={active}
            title={label}
            aria-label={label}
            onClick={() => setTabLayoutMode(activeTabIndex, mode)}
          >
            <Icon size={16} />
          </button>
        );
      })}
    </div>
  );
}
