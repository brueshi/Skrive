// Top bar of the workspace. Houses the sidebar toggle, project menu,
// the Notion-style tab strip, and the layout-mode toggle.
//
// The window uses macOS hiddenInset titleBarStyle (main.ts), so traffic
// lights float over our chrome. We pad the header on macOS only;
// Windows has native chrome above the app and doesn't need the offset.
//
// Panel-toggle buttons live between the tab strip and the mode toggle:
// FM (frontmatter), backlinks, HI (history). The dictionary panel is
// post-port. When the active tab is showing a diff, the editor mode
// toggle hides — DiffView carries its own diff-raw / diff-preview
// toggle and exit affordance.

import { useEffect, useMemo, type CSSProperties } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  selectActiveTab,
  useProjectStore,
  type Tab
} from '../../stores/project';
import { IconBacklinks } from '../icons/IconBacklinks';
import { IconDocMarkdown } from '../icons/IconDocMarkdown';
import { IconDotUnsaved } from '../icons/IconDotUnsaved';
import { IconLayoutPreview } from '../icons/IconLayoutPreview';
import { IconLayoutRaw } from '../icons/IconLayoutRaw';
import { IconLayoutSplit } from '../icons/IconLayoutSplit';
import { IconSidebarToggle } from '../icons/IconSidebarToggle';
import { IconX } from '../icons/IconX';
import type { LayoutMode } from '../editor/SplitView';

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
  const historyPanelOpen = useProjectStore((s) => s.historyPanelOpen);
  const toggleHistoryPanel = useProjectStore((s) => s.toggleHistoryPanel);
  const historyMode = useProjectStore((s) => s.historyMode);

  const frontmatterCount = activeTab
    ? Object.keys(activeTab.frontmatter).length
    : 0;
  const inDiff = !!activeTab?.diff;

  function setMode(mode: LayoutMode) {
    if (activeTabIndex < 0) return;
    setTabLayoutMode(activeTabIndex, mode);
  }

  function isMode(mode: LayoutMode): boolean {
    return activeTab?.layoutMode === mode;
  }

  function handleCloseTab(e: React.MouseEvent, i: number) {
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
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="project-name"
                  title={manifest.root}
                >
                  <span className="project-name-text">
                    {projectName(manifest.root)}
                  </span>
                  <span className="project-name-caret" aria-hidden="true">
                    ▾
                  </span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="ctx-menu"
                  align="start"
                  sideOffset={4}
                >
                  <DropdownMenu.Item
                    className="ctx-item"
                    onSelect={() => void openProjectFromDialog()}
                  >
                    <span className="ctx-label">Open project…</span>
                    <span className="ctx-shortcut">⌘O</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="ctx-item"
                    onSelect={() => void closeProject()}
                  >
                    <span className="ctx-label">Close project</span>
                    <span className="ctx-shortcut">⌘⇧W</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
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
              title="Backlinks  ⌘⇧B"
              onClick={() => toggleBacklinksPanel()}
            >
              <IconBacklinks size={16} />
            </button>
          )}
          {activeTab && (
            <button
              type="button"
              className="hi-indicator"
              data-panel-toggle="history"
              aria-label="Toggle history panel"
              aria-pressed={historyPanelOpen}
              title={
                historyMode === 'git'
                  ? 'History (git)  ⌘⇧H'
                  : 'History (checkpoints)  ⌘⇧H'
              }
              onClick={() => toggleHistoryPanel()}
            >
              <span>HI</span>
            </button>
          )}
          {activeTab && !inDiff && (
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
    </>
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
        <IconDocMarkdown size={16} />
      </span>
      <span className="tab-name">{name}</span>
      {tab.dirty && (
        <span className="tab-dirty" aria-label="unsaved changes">
          <IconDotUnsaved size={16} />
        </span>
      )}
      {/* The close affordance is intentionally not a real interactive
          element — a <button> nested in the parent <button role="tab">
          is invalid HTML, and a focusable inner control would split the
          tab's keyboard activation between Enter (select) and Space
          (close), which is confusing. Mouse close still works via the
          click bubbling to onClose; keyboard users close via ⌘W or the
          right-click context menu. */}
      <span
        className="tab-close"
        aria-hidden="true"
        onClick={onClose}
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
