// Custom window controls for the frameless Windows host (Zig shell, B3). That
// host draws no native title bar, so the renderer owns minimize / maximize-
// restore / close. They are shown ONLY when the host advertises frameless mode
// (`window.__SKRIVE_FRAMELESS__`) and calls go through the host-injected
// `window.__skriveWindow` API — both absent on macOS and in Electron, where the
// OS draws the controls. So this renders nothing in every other shell.
//
// Glyphs follow the Windows convention (line / square / overlap / X) at the
// standard top-right, but inherit Skrive's typographic weight and tone tokens
// rather than the OS metrics — custom chrome, native muscle memory.

import { useEffect, useState, type CSSProperties } from 'react';
import { NO_DRAG_ATTR } from './windowDrag';

// Host-injected control surface; see shell-zig/web/native-bridge-win.ts.
type SkriveWindowApi = {
  minimize(): Promise<unknown>;
  toggleMaximize(): Promise<unknown>;
  close(): Promise<unknown>;
  isMaximized(): Promise<{ maximized: boolean }>;
  onMaximizeChanged(cb: (maximized: boolean) => void): () => void;
};

declare global {
  interface Window {
    __SKRIVE_FRAMELESS__?: boolean;
    __skriveWindow?: SkriveWindowApi;
  }
}

const frameless =
  typeof window !== 'undefined' && window.__SKRIVE_FRAMELESS__ === true;

// The controls sit in the non-draggable lane of the otherwise-draggable header.
// Declared twice: the CSS for Electron and the Windows host, the attribute for the
// macOS host's mousedown handler, which cannot see the CSS (SKR-240). This component
// renders only on the frameless Windows host, so the attribute is belt-and-braces —
// but a no-drag lane that only half-announces itself is exactly how a button becomes
// a drag handle later.
const noDrag: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties;
const noDragProps = { style: noDrag, [NO_DRAG_ATTR]: true };

export function WindowControls() {
  const api = typeof window !== 'undefined' ? window.__skriveWindow : undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!api) return;
    let active = true;
    api
      .isMaximized()
      .then((r) => {
        if (active) setMaximized(Boolean(r?.maximized));
      })
      .catch(() => {});
    // Host pushes window:maximizeChanged on every real transition; returns an
    // unsubscribe.
    const off = api.onMaximizeChanged((m) => setMaximized(m));
    return () => {
      active = false;
      off();
    };
  }, [api]);

  // Defensive: only render in the frameless host with the API present.
  if (!frameless || !api) return null;

  return (
    <div className="window-controls" {...noDragProps}>
      <button
        type="button"
        className="window-control"
        aria-label="Minimize"
        onClick={() => api.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => api.toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="2.6" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M3 2.6 V1 H9 V7 H7.4" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        aria-label="Close"
        onClick={() => api.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1" />
          <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
