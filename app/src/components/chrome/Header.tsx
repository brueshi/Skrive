// Top bar of the workspace. Houses the sidebar toggle, the centered
// front-title (+ its summon fan, SKR-243 — the tab strip is gone), and
// the per-document tool cluster (the panel popover). The full-cluster
// ("classic") and bottom-rail ("collapsed-bottom") variants were retired
// in the 13c stabilization pass — this is the only topbar layout that
// ships.
//
// The window uses macOS hiddenInset titleBarStyle (main.ts), so traffic
// lights float over our chrome. We pad the header on macOS only;
// Windows has native chrome above the app and doesn't need the offset.
//
// The project menu lives in the sidebar's section header — not here.

import { type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { IconButton } from '../ui/IconButton';
import {
  selectLiveDoc,
  useProjectStore
} from '../../stores/project';
import { IconSidebarToggle } from '../icons/IconSidebarToggle';
import { Tooltip } from '../ui/Tooltip';
import { FrontTitle } from './FrontTitle';
import { PanelMenu } from './PanelMenu';
import { WindowControls } from './WindowControls';
import { DRAG_REGION_ATTR, handleChromeMouseDown, noDragProps } from './windowDrag';

const isMacOS =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

// Frameless Windows host (Zig shell, B3): the renderer owns the window
// controls, so the header reserves space for them and re-centers the settings
// title. False in every other shell (the OS draws the title bar there).
const isFrameless =
  typeof window !== 'undefined' && window.__SKRIVE_FRAMELESS__ === true;

type HeaderProps = {
  /** Opens the ⌘P switcher — threaded to the front-title fan's footer
   *  row (the switcher modal lives in App). */
  onOpenSwitcher: () => void;
};

export function Header({ onOpenSwitcher }: HeaderProps) {
  const activeTab = useProjectStore(selectLiveDoc);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const activeView = useProjectStore((s) => s.activeView);
  const setActiveView = useProjectStore((s) => s.setActiveView);

  const headerClass = `header${isMacOS ? ' is-macos' : ''}${
    isFrameless ? ' is-frameless' : ''
  }`;
  // The drag lane is declared TWICE, on purpose, and both are load-bearing:
  //   - `-webkit-app-region` is what Electron and the Windows host (WebView2's
  //     non-client-region support) read. It is a Chromium extension.
  //   - the data attributes are what the macOS host reads, via the mousedown handler
  //     below, because WKWebView does not implement that CSS property at all and
  //     ignores it silently (SKR-240).
  // Drop either one and a shell loses its window dragging, quietly.
  const dragProps = {
    style: { WebkitAppRegion: 'drag' } as CSSProperties,
    [DRAG_REGION_ATTR]: true,
    onMouseDown: (e: ReactMouseEvent) => {
      handleChromeMouseDown(e);
    }
  };

  // Settings is a full-page view, not a modal — the topbar collapses to
  // Back / Settings / Done so the chrome matches the focused context.
  if (activeView === 'settings') {
    return (
      <header className={`${headerClass} header-settings`} {...dragProps}>
        <div className="header-left" {...noDragProps}>
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
    <header className={headerClass} {...dragProps}>
      <div className="header-left" {...noDragProps}>
        <Tooltip
          label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          shortcut="⌘["
          side="bottom"
        >
          <IconButton
            size="lg"
            className="sidebar-toggle"
            aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            aria-pressed={sidebarVisible}
            onClick={() => toggleSidebar()}
          >
            <IconSidebarToggle size={16} shown={sidebarVisible} />
          </IconButton>
        </Tooltip>
      </div>

      {/* NOT no-drag: this box is flex:1, so opting it out would consume the
          entire topbar's drag lane (SKR-240). It only holds the band open
          between the left and right clusters. */}
      <div className="header-spacer" />

      {/* The front-title (SKR-243): centered over the whole band so the
          left/right cluster widths can't skew it. The slot is pointer-
          transparent; only the title button itself takes clicks (and opts
          out of window dragging). */}
      <FrontTitle onOpenSwitcher={onOpenSwitcher} />

      {activeTab && (
        <div className="header-right" {...noDragProps}>
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
