// Dragging the window by the topbar (SKR-240).
//
// The header is marked `-webkit-app-region: drag`, with the interactive lanes opted
// out as `no-drag`. That property is a Chromium extension: the Windows host turns on
// WebView2's non-client-region support and the browser does the rest, and Electron
// implements it natively. WKWebView does not implement it at all, and ignores it in
// silence — so on macOS the header was inert, and because the webview is the window's
// contentView under a full-size-content titlebar, it covers the native titlebar band
// too. The window could not be moved from anywhere.
//
// The macOS host injects `window.__skriveWindowDrag` (see shell-zig/web/
// native-bridge.ts) and drags the window with `NSWindow.performDrag`. This module
// decides WHEN to ask it to, which is the part worth testing: the CSS opt-outs mean
// nothing to a JS listener, so the no-drag lanes have to be re-stated as DOM
// attributes and honored here.
//
// Every other host leaves `__skriveWindowDrag` undefined and keeps its CSS behavior.
// Its absence is the feature test — never a platform sniff.

import type { CSSProperties } from 'react';

/** Marks the region a drag may start in. Mirrors `-webkit-app-region: drag`. */
export const DRAG_REGION_ATTR = 'data-drag-region';
/** Marks an interactive island inside it. Mirrors `-webkit-app-region: no-drag`. */
export const NO_DRAG_ATTR = 'data-no-drag';

/**
 * Opt an element out of window dragging. Spread onto the CONTROL — a button,
 * the front-title — and never onto the layout box that holds it.
 *
 * That distinction is the whole bug: the flex:1 middle of the topbar (the tab
 * strip then, `.header-spacer` now) is the main drag lane, and marking the
 * container no-drag consumed all of it and left no pixels to grab. It went
 * unnoticed under Electron, whose `hiddenInset` titlebar gave the window a
 * native drag band regardless. Our webview covers that band, so the renderer's
 * drag lane is the only one there is.
 *
 * Both forms are emitted together: the CSS for Electron and the Windows host, the
 * attribute for the macOS host's mousedown handler, which cannot see the CSS.
 */
export const noDragProps = {
  style: { WebkitAppRegion: 'no-drag' } as CSSProperties,
  [NO_DRAG_ATTR]: true
} as const;

type WindowDragHost = { start(): void; toggleZoom(): void };

declare global {
  interface Window {
    /** Injected by the macOS host only. Absent in Electron, the Windows host, the
     *  Vite dev server in a plain browser, and the test harness. */
    __skriveWindowDrag?: WindowDragHost;
  }
}

function host(): WindowDragHost | undefined {
  return typeof window === 'undefined' ? undefined : window.__skriveWindowDrag;
}

/** True when this host drags the window itself (macOS). Callers use it to avoid
 *  attaching listeners that would never fire anywhere else. */
export function hasNativeWindowDrag(): boolean {
  return host() !== undefined;
}

/**
 * Should a mousedown at `target` begin a window drag?
 *
 * Only a primary-button press, inside a drag region, outside every interactive
 * island within it. A press on a button or a tab must stay a press: `performDrag`
 * swallows the rest of the gesture, so getting this wrong turns controls into inert
 * drag handles rather than merely feeling wrong.
 */
export function isDragRegionTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (el.closest(`[${NO_DRAG_ATTR}]`)) return false;
  return el.closest(`[${DRAG_REGION_ATTR}]`) !== null;
}

/**
 * Begin a window drag, or zoom on a double-click. Returns true when the host took
 * the gesture, so the caller knows the press will produce no mouseup.
 *
 * Zoom is decided HERE rather than on a `dblclick` listener, because `performDrag`
 * runs its own event loop to mouse-up and the second click's `dblclick` would never
 * be dispatched. `detail === 2` is the second press of the pair, and it must be
 * checked before we hand the first one to AppKit.
 */
export function handleChromeMouseDown(e: {
  button: number;
  detail: number;
  target: EventTarget | null;
}): boolean {
  const api = host();
  if (!api) return false;
  if (e.button !== 0) return false; // secondary/middle: leave the menu and paste alone
  if (!isDragRegionTarget(e.target)) return false;
  if (e.detail === 2) {
    api.toggleZoom();
    return true;
  }
  api.start();
  return true;
}
