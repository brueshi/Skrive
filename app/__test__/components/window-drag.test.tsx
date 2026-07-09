// @vitest-environment jsdom
//
// SKR-240 — dragging the window by the topbar on macOS.
//
// The header is marked `-webkit-app-region: drag`. That is a Chromium extension:
// Electron implements it, the Windows host gets it from WebView2's non-client-region
// support, and WKWebView ignores it entirely and in silence. So on macOS the header
// was inert — and since the webview is the window's contentView under a full-size
// -content titlebar, it covers the native titlebar band too. The window could not be
// moved from anywhere. A regression from the Electron shell that no test could see.
//
// The macOS host now injects `window.__skriveWindowDrag`. These fixtures pin the
// decision of WHEN to call it, which is where the bugs live: the CSS opt-outs are
// invisible to a JS listener, so a button in the header would become a drag handle if
// the no-drag lanes were not re-stated as attributes and honored.
//
// Its ABSENCE is the feature test. Every other host must be untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DRAG_REGION_ATTR,
  NO_DRAG_ATTR,
  hasNativeWindowDrag,
  isDragRegionTarget,
  handleChromeMouseDown
} from '../../src/components/chrome/windowDrag';

const start = vi.fn();
const toggleZoom = vi.fn();

function installHost(): void {
  window.__skriveWindowDrag = { start, toggleZoom };
}
function removeHost(): void {
  delete window.__skriveWindowDrag;
}

let header: HTMLElement;
let button: HTMLElement;

beforeEach(() => {
  start.mockClear();
  toggleZoom.mockClear();
  // <header data-drag-region> <div data-no-drag> <button/> </div> <span/> </header>
  header = document.createElement('header');
  header.setAttribute(DRAG_REGION_ATTR, 'true');
  const lane = document.createElement('div');
  lane.setAttribute(NO_DRAG_ATTR, 'true');
  button = document.createElement('button');
  lane.appendChild(button);
  header.appendChild(lane);
  header.appendChild(document.createElement('span')); // bare draggable chrome
  document.body.appendChild(header);
});

afterEach(() => {
  header.remove();
  removeHost();
});

const press = (target: EventTarget | null, over: Partial<{ button: number; detail: number }> = {}) =>
  handleChromeMouseDown({ button: 0, detail: 1, target, ...over });

describe('SKR-240: which press starts a window drag', () => {
  it('a press on bare header chrome starts a drag', () => {
    installHost();
    expect(press(header.querySelector('span'))).toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });

  it('a press on the header itself starts a drag', () => {
    installHost();
    expect(press(header)).toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });

  // performDrag swallows the rest of the gesture, so a button caught by the drag
  // handler does not merely feel wrong — it stops being a button.
  it('a press on a button inside a no-drag lane does NOT drag', () => {
    installHost();
    expect(press(button)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('a press on the no-drag lane itself does NOT drag', () => {
    installHost();
    expect(press(header.querySelector(`[${NO_DRAG_ATTR}]`))).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('a press outside any drag region does NOT drag', () => {
    installHost();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    expect(press(outside)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    outside.remove();
  });

  it('a secondary-button press does NOT drag', () => {
    installHost();
    expect(press(header, { button: 2 })).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('SKR-240: double-click zooms', () => {
  // Decided on mousedown, not on a dblclick listener: performDrag runs its own event
  // loop to mouse-up, so the pair's `dblclick` would never be dispatched.
  it('the second press of a double-click zooms instead of dragging', () => {
    installHost();
    expect(press(header, { detail: 2 })).toBe(true);
    expect(toggleZoom).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it('a double-click on a no-drag lane does nothing', () => {
    installHost();
    expect(press(button, { detail: 2 })).toBe(false);
    expect(toggleZoom).not.toHaveBeenCalled();
  });
});

describe('SKR-240: every other host is untouched', () => {
  it('reports no native window drag when the host injects nothing', () => {
    expect(hasNativeWindowDrag()).toBe(false);
  });

  it('a press is inert without the host, however draggable the target looks', () => {
    expect(press(header)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(toggleZoom).not.toHaveBeenCalled();
  });

  it('reports a native window drag once the host injects it', () => {
    installHost();
    expect(hasNativeWindowDrag()).toBe(true);
  });
});

describe('SKR-240: region test is independent of the host', () => {
  it('reads the attributes, not the app-region CSS', () => {
    expect(isDragRegionTarget(header)).toBe(true);
    expect(isDragRegionTarget(button)).toBe(false);
    expect(isDragRegionTarget(null)).toBe(false);
    expect(isDragRegionTarget(document.body)).toBe(false);
  });
});

// The unit fixtures above would all pass even if Header never called any of this.
// That is precisely the shape of the bug: a drag lane declared and then not wired to
// anything. Render the real header and press it.
describe('SKR-240: the Header is actually wired to it', () => {
  it('a mousedown on the header asks the host to drag the window', async () => {
    installHost();
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    const React = (await import('react')).default;
    const { Header } = await import('../../src/components/chrome/Header');
    const { TooltipProvider } = await import('../../src/components/ui/Tooltip');
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const root = createRoot(mount);
    // Header's sidebar toggle is wrapped in a Tooltip, which needs its provider.
    act(() => root.render(React.createElement(TooltipProvider, null, React.createElement(Header))));

    const rendered = mount.querySelector('header')!;
    expect(rendered.hasAttribute(DRAG_REGION_ATTR), 'the header declares itself a drag region').toBe(true);

    act(() => {
      rendered.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }));
    });
    expect(start, 'the header handed the press to the host').toHaveBeenCalledOnce();

    // And the sidebar toggle, which lives in a no-drag lane, must stay a button.
    start.mockClear();
    const toggle = rendered.querySelector('.sidebar-toggle')!;
    act(() => {
      toggle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }));
    });
    expect(start, 'a press on the sidebar toggle is not a window drag').not.toHaveBeenCalled();

    act(() => root.unmount());
    mount.remove();
  });
});
