// Top bar of the workspace. Houses the sidebar toggle, the
// Notion-style tab strip, and the per-document tool cluster: a panel
// popover (FM/Backlinks/History) plus the Raw/Split/Preview mode
// toggle. The full-cluster ("classic") and bottom-rail ("collapsed-
// bottom") variants were retired in the 13c stabilization pass — this
// is the only topbar layout that ships.
//
// The window uses macOS hiddenInset titleBarStyle (main.ts), so traffic
// lights float over our chrome. We pad the header on macOS only;
// Windows has native chrome above the app and doesn't need the offset.
//
// The project menu lives in the sidebar's section header — not here.

import { type CSSProperties } from 'react';
import {
  selectActiveTab,
  useProjectStore
} from '../../stores/project';
import { IconSidebarToggle } from '../icons/IconSidebarToggle';
import { platformShortcut } from '../../lib/commands/shortcut-display';
import { PanelMenu } from './PanelMenu';
import { TabBar } from './TabBar';
import { WindowControls } from './WindowControls';

const isMacOS =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

// Frameless Windows host (Zig shell, B3): the renderer owns the window
// controls, so the header reserves space for them and re-centers the settings
// title. False in every other shell (the OS draws the title bar there).
const isFrameless =
  typeof window !== 'undefined' && window.__SKRIVE_FRAMELESS__ === true;

export function Header() {
  const activeTab = useProjectStore(selectActiveTab);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const activeView = useProjectStore((s) => s.activeView);
  const setActiveView = useProjectStore((s) => s.setActiveView);

  const headerClass = `header${isMacOS ? ' is-macos' : ''}${
    isFrameless ? ' is-frameless' : ''
  }`;
  const dragStyle: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties;
  const noDragStyle: CSSProperties = {
    WebkitAppRegion: 'no-drag'
  } as CSSProperties;

  // Settings is a full-page view, not a modal — the topbar collapses to
  // Back / Settings / Done so the chrome matches the focused context.
  if (activeView === 'settings') {
    return (
      <header className={`${headerClass} header-settings`} style={dragStyle}>
        <div className="header-left" style={noDragStyle}>
          <button
            type="button"
            className="settings-back"
            onClick={() => setActiveView('editor')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M10 3.5L5.5 8L10 12.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back to editor
          </button>
        </div>
        <div className="header-settings-title">Settings</div>
        {/* Empty right cluster balances the left so the title stays
            centered; left draggable (no button to opt out for). */}
        <div className="header-right" />
        {/* Custom window controls (frameless Windows host only; renders null
            elsewhere). Kept here too so they persist into the settings view. */}
        <WindowControls />
      </header>
    );
  }

  return (
    <header className={headerClass} style={dragStyle}>
      <div className="header-left" style={noDragStyle}>
        <button
          type="button"
          className="header-icon-button sidebar-toggle"
          aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          aria-pressed={sidebarVisible}
          title={platformShortcut('Toggle sidebar  ⌘[')}
          onClick={() => toggleSidebar()}
        >
          <IconSidebarToggle size={16} shown={sidebarVisible} />
        </button>
      </div>

      <span className="header-sep" aria-hidden="true" />

      <div style={noDragStyle} className="header-tabs">
        <TabBar />
      </div>

      {activeTab && (
        <div className="header-right" style={noDragStyle}>
          {/* Save status lives in the editor toolbar band (EditorBar, SKR-123);
              the rendered/source switch was retired to the command palette
              (SKR-126). The panel popover stays in the topbar. */}
          <PanelMenu />
        </div>
      )}

      {/* Custom window controls (frameless Windows host only; renders null
          elsewhere) — flush to the top-right window corner. */}
      <WindowControls />
    </header>
  );
}
