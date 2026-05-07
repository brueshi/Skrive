// Top bar of the workspace. Houses the sidebar toggle, project menu,
// the Notion-style tab strip, and the layout-mode toggle.
//
// The window uses macOS hiddenInset titleBarStyle (main.ts), so traffic
// lights float over our chrome. We pad the header on macOS only;
// Windows has native chrome above the app and doesn't need the offset.
//
// Panel-toggle buttons (frontmatter / backlinks / dictionary / history)
// are intentionally absent at v0.2 Phase 4 — the panels they target
// land in Phases 6/7/9/10. Their slot lives between the project menu
// and the mode toggle, ready to receive them.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  selectActiveTab,
  useProjectStore,
  type Tab
} from '../../stores/project';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import { IconBacklinks } from '../icons/IconBacklinks';
import { IconDocMarkdown } from '../icons/IconDocMarkdown';
import { IconDotUnsaved } from '../icons/IconDotUnsaved';
import { IconLayoutPreview } from '../icons/IconLayoutPreview';
import { IconLayoutRaw } from '../icons/IconLayoutRaw';
import { IconLayoutSplit } from '../icons/IconLayoutSplit';
import { IconSidebarToggle } from '../icons/IconSidebarToggle';
import { IconX } from '../icons/IconX';
import type { LayoutMode } from '../editor/SplitView';

type ProjectMenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
};

const isMacOS =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

function leafName(p: string): string {
  const lastSep = p.lastIndexOf('/');
  return lastSep === -1 ? p : p.slice(lastSep + 1);
}

function projectName(root: string | null | undefined): string {
  if (!root) return '';
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

export function Header() {
  const manifest = useProjectStore((s) => s.manifest);
  const tabs = useProjectStore((s) => s.tabs);
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const activeTab = useProjectStore(selectActiveTab);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const switchTab = useProjectStore((s) => s.switchTab);
  const closeTab = useProjectStore((s) => s.closeTab);
  const setTabLayoutMode = useProjectStore((s) => s.setTabLayoutMode);
  const openProjectFromDialog = useProjectStore(
    (s) => s.openProjectFromDialog
  );
  const closeProject = useProjectStore((s) => s.closeProject);
  const backlinksPanelOpen = useProjectStore((s) => s.backlinksPanelOpen);
  const toggleBacklinksPanel = useProjectStore(
    (s) => s.toggleBacklinksPanel
  );
  const frontmatterPanelOpen = useProjectStore(
    (s) => s.frontmatterPanelOpen
  );
  const toggleFrontmatterPanel = useProjectStore(
    (s) => s.toggleFrontmatterPanel
  );

  const frontmatterCount = activeTab
    ? Object.keys(activeTab.frontmatter).length
    : 0;

  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);

  function openProjectMenu(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const items: ContextMenuItem[] = [
      {
        label: 'Open project…',
        shortcut: '⌘O',
        onClick: () => void openProjectFromDialog()
      },
      {
        label: 'Close project',
        shortcut: '⌘⇧W',
        onClick: () => void closeProject()
      }
    ];
    setProjectMenu({ x: rect.left, y: rect.bottom + 4, items });
  }

  function setMode(mode: LayoutMode) {
    if (activeTabIndex < 0) return;
    setTabLayoutMode(activeTabIndex, mode);
  }

  function isMode(mode: LayoutMode): boolean {
    return activeTab?.layoutMode === mode;
  }

  function handleCloseTab(e: React.MouseEvent | React.KeyboardEvent, i: number) {
    e.stopPropagation();
    void closeTab(i);
  }

  const headerClass = `header${isMacOS ? ' is-macos' : ''}`;
  const dragStyle: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties;
  const noDragStyle: CSSProperties = {
    WebkitAppRegion: 'no-drag'
  } as CSSProperties;

  return (
    <>
      <header className={headerClass} style={dragStyle}>
        <div className="header-left" style={noDragStyle}>
          <button
            type="button"
            className="header-icon-button sidebar-toggle"
            aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            aria-pressed={sidebarVisible}
            title="Toggle sidebar  ⌘B"
            onClick={() => toggleSidebar()}
          >
            <IconSidebarToggle size={16} shown={sidebarVisible} />
          </button>
          {manifest && (
            <button
              type="button"
              className="project-name"
              title={manifest.root}
              aria-haspopup="menu"
              aria-expanded={projectMenu !== null}
              onClick={openProjectMenu}
            >
              <span className="project-name-text">
                {projectName(manifest.root)}
              </span>
              <span className="project-name-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          )}
        </div>

        <div className="tabs" role="tablist" style={noDragStyle}>
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

        <div className="header-right" style={noDragStyle}>
          {activeTab && (
            <button
              type="button"
              className="fm-indicator"
              data-panel-toggle="frontmatter"
              aria-label="Toggle frontmatter panel"
              aria-pressed={frontmatterPanelOpen}
              title="Frontmatter  ⌘⇧F"
              onClick={() => toggleFrontmatterPanel()}
            >
              <span>FM</span>
              {frontmatterCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="fm-indicator-count">
                    {frontmatterCount}
                  </span>
                </>
              )}
            </button>
          )}
          {activeTab && (
            <button
              type="button"
              className="header-icon-button"
              data-panel-toggle="backlinks"
              aria-label="Toggle backlinks panel"
              aria-pressed={backlinksPanelOpen}
              title="Backlinks"
              onClick={() => toggleBacklinksPanel()}
            >
              <IconBacklinks size={16} />
            </button>
          )}
          {activeTab && (
            <div className="mode-toggle" role="group" aria-label="Layout mode">
              <button
                type="button"
                className={`mode-button${isMode('raw') ? ' active' : ''}`}
                aria-pressed={isMode('raw')}
                title="Raw  ⌘1"
                onClick={() => setMode('raw')}
              >
                <IconLayoutRaw size={16} />
              </button>
              <button
                type="button"
                className={`mode-button${isMode('split') ? ' active' : ''}`}
                aria-pressed={isMode('split')}
                title="Split  ⌘2"
                onClick={() => setMode('split')}
              >
                <IconLayoutSplit size={16} />
              </button>
              <button
                type="button"
                className={`mode-button${isMode('preview') ? ' active' : ''}`}
                aria-pressed={isMode('preview')}
                title="Preview  ⌘3"
                onClick={() => setMode('preview')}
              >
                <IconLayoutPreview size={16} />
              </button>
            </div>
          )}
        </div>
      </header>

      {projectMenu && (
        <ContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          items={projectMenu.items}
          onDismiss={() => setProjectMenu(null)}
        />
      )}
    </>
  );
}

type TabPillProps = {
  tab: Tab;
  active: boolean;
  onSelect: () => void;
  onClose: (e: React.MouseEvent | React.KeyboardEvent) => void;
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
        <IconDocMarkdown size={16} />
      </span>
      <span className="tab-name">{name}</span>
      {tab.dirty && (
        <span className="tab-dirty" aria-label="unsaved changes">
          <IconDotUnsaved size={16} />
        </span>
      )}
      <span
        className="tab-close"
        role="button"
        tabIndex={-1}
        aria-label="Close tab"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onClose(e);
        }}
      >
        <IconX size={16} />
      </span>
    </button>
  );
}

// Hook helper: register window-level chrome shortcuts that aren't
// covered by the editor's CM6 keymap. ⌘W closes the active tab,
// ⌘⌥← / ⌘⌥→ navigate tabs (Notion-flavored).
export function useChromeShortcuts() {
  const closeTab = useProjectStore((s) => s.closeTab);
  const switchTab = useProjectStore((s) => s.switchTab);
  const activeTabIndex = useProjectStore((s) => s.activeTabIndex);
  const tabs = useProjectStore((s) => s.tabs);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'w' || e.key === 'W') {
        if (e.shiftKey || e.altKey) return;
        if (activeTabIndex < 0) return;
        e.preventDefault();
        void closeTab(activeTabIndex);
        return;
      }
      // ⌘⇧[ / ⌘⇧] — macOS-standard previous/next tab (iTerm, Safari).
      // We match `e.code` (BracketLeft / BracketRight) instead of `e.key`
      // because the latter resolves to `{` / `}` when shift is held and
      // is layout-dependent — `e.code` is keyboard-position-based and
      // stable across layouts.
      if (e.shiftKey && e.code === 'BracketLeft') {
        e.preventDefault();
        if (tabs.length === 0) return;
        switchTab((activeTabIndex - 1 + tabs.length) % tabs.length);
      } else if (e.shiftKey && e.code === 'BracketRight') {
        e.preventDefault();
        if (tabs.length === 0) return;
        switchTab((activeTabIndex + 1) % tabs.length);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeTab, switchTab, activeTabIndex, tabs.length]);
}
