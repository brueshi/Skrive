// @vitest-environment jsdom
//
// SKR-187 / F29 — the Preview click policy.
//
// Preview renders file markdown with `allowDangerousHtml`, so an anchor can come
// from raw HTML in the document as easily as from a markdown link. The plain-click
// path was already safe by accident: it calls `links.openExternal`, and the Swift
// host refuses any scheme outside its allowlist. The MODIFIER-click path was not —
// it returned early and handed the click to the browser, which navigates a
// `javascript:` href in the app's own origin without the host ever seeing it.
//
// These fixtures pin both: nothing dangerous reaches the host, and nothing
// dangerous survives to a default navigation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import React from 'react';
import { Preview } from '../../src/components/editor/Preview';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mountEl: HTMLElement;
let root: Root | null = null;
const openExternal = vi.fn(() => Promise.resolve());

beforeEach(() => {
  openExternal.mockClear();
  (window as unknown as { skrive: unknown }).skrive = { links: { openExternal } };
  mountEl = document.createElement('div');
  document.body.appendChild(mountEl);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  mountEl.remove();
});

function mount(body: string): void {
  root = createRoot(mountEl);
  act(() => root!.render(React.createElement(Preview, { body })));
}

/** Click the first anchor, returning whether the default action was prevented. */
function clickAnchor(init: MouseEventInit = {}): boolean {
  const a = mountEl.querySelector('a');
  if (!a) throw new Error('no anchor rendered');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  act(() => {
    a.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

describe('Preview refuses a dangerous href', () => {
  it('a plain click neither navigates nor reaches the host', () => {
    mount('<a href="javascript:alert(1)">click</a>');
    expect(clickAnchor(), 'default navigation prevented').toBe(true);
    expect(openExternal, 'the host is never asked to open it').not.toHaveBeenCalled();
  });

  // The bug: the modifier bail ran BEFORE any scheme check, so this click fell
  // through to the browser's default action — a javascript: navigation.
  it('a Cmd-click does not fall through to the browser', () => {
    mount('<a href="javascript:alert(1)">click</a>');
    expect(clickAnchor({ metaKey: true }), 'default navigation prevented').toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('a Shift-click does not fall through either', () => {
    mount('<a href="javascript:alert(1)">click</a>');
    expect(clickAnchor({ shiftKey: true })).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('an obfuscated scheme is refused', () => {
    mount('<a href="java&#9;script:alert(1)">click</a>');
    expect(clickAnchor({ metaKey: true })).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('a data: href is refused', () => {
    mount('<a href="data:text/html,<b>x</b>">click</a>');
    expect(clickAnchor()).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('Preview still opens a permitted href', () => {
  it('a plain click on an https link goes to the host', () => {
    mount('[x](https://example.com)');
    expect(clickAnchor()).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('a modifier-click on an https link is left to the browser, as before', () => {
    mount('[x](https://example.com)');
    expect(clickAnchor({ metaKey: true }), 'not prevented — the browser handles it').toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
