// @vitest-environment jsdom
//
// SKR-183 / F75 — the Markdown layout cycle keeps the writer's place.
//
// Cycling raw -> split -> preview REMOUNTS the textarea (it sits at a different
// depth in each layout, so React tears it down rather than moving it). Three things
// must survive that remount, and none of them did:
//
//   1. focus — the incoming pane took none, so typing after the cycle went nowhere
//   2. caret — the new textarea came up at offset 0
//   3. the outgoing edit — the unmount flush read a ref React had already detached,
//      so it drained nothing. Blur and the explicit flushActiveEditor() callers hid
//      this, but the safety net BlockEditor's cleanup cites (SKR-154 / F02) was
//      never actually there on this path.
//
// A document's FIRST mount must still not take focus: opening a file should not
// steal the caret from wherever the writer summoned it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import React from 'react';
import { MarkdownView } from '../../src/components/editor/markdown/MarkdownView';
import { RawSourceView } from '../../src/components/editor/raw/RawSourceView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Preview mounts OutlineRail, which observes its scroller. jsdom implements no
// layout and ships no ResizeObserver; the rail's measurements are not what these
// fixtures are about, so an inert stub is enough to let the pane mount.
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = InertResizeObserver;

let mountEl: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  mountEl = document.createElement('div');
  document.body.appendChild(mountEl);
  root = createRoot(mountEl);
});

afterEach(() => {
  act(() => root?.unmount());
  mountEl.remove();
});

const BODY = 'the quick brown fox\njumps over the lazy dog';

function renderView(layoutMode: 'raw' | 'split' | 'preview', onChange: (next: string) => void = () => {}) {
  act(() => {
    root!.render(
      React.createElement(MarkdownView, {
        body: BODY,
        onChange,
        filePath: '/proj/doc.md',
        projectRoot: '/proj',
        layoutMode,
        splitRatio: 0.5,
        onSplitRatioChange: () => {}
      })
    );
  });
}

const textarea = () => mountEl.querySelector('textarea');

describe('SKR-183: the Markdown layout cycle keeps the writer in place', () => {
  it('does not steal focus when a document first mounts', () => {
    renderView('raw');
    expect(textarea()).not.toBeNull();
    expect(document.activeElement, 'opening a file leaves focus alone').not.toBe(textarea());
  });

  it('focuses the incoming textarea on a layout cycle', () => {
    renderView('raw');
    expect(document.activeElement).not.toBe(textarea());

    renderView('split');
    expect(document.activeElement, 'the split pane textarea took focus').toBe(textarea());
  });

  it('restores the caret across raw -> split', () => {
    renderView('raw');
    const first = textarea()!;
    first.focus();
    first.setSelectionRange(9, 14); // "brown"

    renderView('split');
    const second = textarea()!;
    expect(second, 'the textarea really did remount').not.toBe(first);
    expect([second.selectionStart, second.selectionEnd], 'the selection came back').toEqual([9, 14]);
  });

  // Preview mounts no textarea at all, so the caret has to live in MarkdownView,
  // which outlives the cycle — not in the textarea, which does not.
  it('restores the caret across a round trip through preview', () => {
    renderView('raw');
    const first = textarea()!;
    first.focus();
    first.setSelectionRange(4, 4);

    renderView('preview');
    expect(textarea(), 'preview has no source pane').toBeNull();

    renderView('raw');
    const back = textarea()!;
    expect(back.selectionStart, 'the caret survived a layout with no textarea').toBe(4);
    expect(document.activeElement, 'and the pane took focus').toBe(back);
  });

  it('focuses the preview scroller when cycling into preview', () => {
    renderView('raw');
    renderView('preview');
    const scroller = mountEl.querySelector('.preview');
    expect(scroller, 'the preview scroller exists').not.toBeNull();
    expect(document.activeElement, 'keyboard scrolling acts on the prose').toBe(scroller);
  });
});

describe('SKR-183: the unmount flush actually drains', () => {
  // React detaches a host ref before running the effect destructor, so reading
  // textareaRef.current in cleanup always saw null. The node must be captured at
  // mount. Without that, this test's onChange is never called.
  it('emits the pending edit when the textarea unmounts', () => {
    const onChange = vi.fn();
    act(() => {
      root!.render(React.createElement(RawSourceView, { body: 'before', onChange }));
    });
    const el = textarea()!;
    el.value = 'before, then an unsaved edit';

    act(() => {
      root!.render(React.createElement('div'));
    });

    expect(onChange, 'the unmount drained the textarea').toHaveBeenCalledWith('before, then an unsaved edit');
  });

  it('reports caret and scroll to its owner when it unmounts', () => {
    const onViewStateChange = vi.fn();
    act(() => {
      root!.render(
        React.createElement(RawSourceView, { body: BODY, onChange: () => {}, onViewStateChange })
      );
    });
    textarea()!.setSelectionRange(3, 7);

    act(() => {
      root!.render(React.createElement('div'));
    });

    expect(onViewStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ selectionStart: 3, selectionEnd: 7 })
    );
  });
});
