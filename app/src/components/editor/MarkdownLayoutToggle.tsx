// Markdown source-mode layout switch (SKR-197). A centered text control —
// markdown | split | preview — shown in the EditorBar's middle band only when the
// active tab is a Markdown file (where the formatting toolbar is absent). `.folio`
// rich tabs show the toolbar there instead and get no layout switch.

import { Fragment } from 'react';
import { useProjectStore } from '../../stores/project';
import type { LayoutMode } from '@skrive/shared';

const MODES: ReadonlyArray<{ mode: LayoutMode; label: string }> = [
  { mode: 'raw', label: 'markdown' },
  { mode: 'split', label: 'split' },
  { mode: 'preview', label: 'preview' }
];

export function MarkdownLayoutToggle() {
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const tab = useProjectStore((s) => s.tabs[s.activeTabIndex]);
  const setTabLayoutMode = useProjectStore((s) => s.setTabLayoutMode);

  if (!tab || tab.mode !== 'markdown') return null;

  return (
    <div className="md-layout-toggle" role="group" aria-label="Editor layout">
      {MODES.map(({ mode, label }, i) => {
        const active = tab.layoutMode === mode;
        return (
          <Fragment key={mode}>
            {i > 0 && (
              <span className="md-layout-sep" aria-hidden="true">
                |
              </span>
            )}
            <button
              type="button"
              className={`md-layout-btn${active ? ' active' : ''}`}
              aria-pressed={active}
              onClick={() => setTabLayoutMode(activeTabIndex, mode)}
            >
              {label}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
