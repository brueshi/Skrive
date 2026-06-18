// Notion-style tab strip. Pulled out of Header so it can render in two
// places driven by the tabsLocation preference:
//
//   - 'shell' → inside the topbar, between the project menu and the
//               right cluster (current default)
//   - 'card'  → attached to the top of the editor card, like Arc
//
// Same component, different parent. The CSS variant on the tab strip
// itself is set via the parent's `data-tabs-location` attribute on the
// app-root.

import { useMemo } from 'react';
import {
  useProjectStore,
  type Tab
} from '../../stores/project';
import { DocIcon } from '../icons/DocIcon';
import { IconDotUnsaved } from '../icons/IconDotUnsaved';
import { IconX } from '../icons/IconX';

function leafName(p: string): string {
  const lastSep = p.lastIndexOf('/');
  return lastSep === -1 ? p : p.slice(lastSep + 1);
}

export function TabBar() {
  const tabs = useProjectStore((s) => s.tabs);
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const switchTab = useProjectStore((s) => s.switchTab);
  const closeTab = useProjectStore((s) => s.closeTab);

  function handleCloseTab(e: React.MouseEvent, i: number) {
    e.stopPropagation();
    void closeTab(i);
  }

  if (tabs.length === 0) return null;

  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab, i) => (
        <TabPill
          key={tab.path}
          tab={tab}
          active={i === activeTabIndex}
          onSelect={() => switchTab(i)}
          onClose={(e) => handleCloseTab(e, i)}
        />
      ))}
    </div>
  );
}

type TabPillProps = {
  tab: Tab;
  active: boolean;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
};

function TabPill({ tab, active, onSelect, onClose }: TabPillProps) {
  const name = useMemo(() => leafName(tab.path), [tab.path]);
  return (
    <button
      type="button"
      role="tab"
      className={`tab${active ? ' active' : ''}`}
      aria-selected={active}
      onClick={onSelect}
      title={tab.path}
    >
      <span className="tab-icon" aria-hidden="true">
        <DocIcon path={tab.path} size={16} />
      </span>
      <span className="tab-name">{name}</span>
      {tab.dirty && (
        <span className="tab-dirty" aria-label="unsaved changes">
          <IconDotUnsaved size={16} />
        </span>
      )}
      {/* Close affordance is a non-interactive span — see Header.tsx
          comment for rationale. Mouse close still works via click
          bubbling; keyboard users close via ⌘W. */}
      <span className="tab-close" aria-hidden="true" onClick={onClose}>
        <IconX size={16} />
      </span>
    </button>
  );
}
