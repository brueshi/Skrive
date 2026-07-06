// @vitest-environment jsdom
//
// The pending-snapshot drain contract (SKR-154 / F01, F03). The surface debounces
// the cold path, then defers the real onDocChange into requestIdleCallback. flush()
// (⌘S / quit / unmount) must drain that deferred emit synchronously — the bug was a
// bare debounceTimer check that went blind the moment the debounce handed off to
// idle, so a save inside that window persisted a stale body.
//
// This is a white-box test: it drives the private scheduleSerialize directly and
// stubs requestIdleCallback so the idle emit never runs on its own, holding the
// surface in exactly the window flush() must cover. Editing through the public API
// needs a live DOM selection jsdom doesn't model, hence the direct drive.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type Document } from '../../src/lib/blockmodel';

type Drivable = { scheduleSerialize(): void };

function schedule(surface: BlockSurface): void {
  (surface as unknown as Drivable).scheduleSerialize();
}

describe('BlockSurface snapshot drain', () => {
  let container: HTMLElement;
  let idleCallbacks: Array<() => void>;
  let cancelIdle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    // Capture the deferred idle callback instead of running it, so tests sit in
    // the post-debounce / pre-emit window where flush() has to do the work.
    idleCallbacks = [];
    cancelIdle = vi.fn();
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
      idleCallbacks.push(cb);
      return idleCallbacks.length;
    });
    vi.stubGlobal('cancelIdleCallback', cancelIdle);
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function makeSurface(onDocChange: (doc: unknown) => void): BlockSurface {
    return new BlockSurface({
      container,
      doc: parseDocument('hello world'),
      onDocChange: onDocChange as (doc: Document) => void
    });
  }

  it('flush() drains a snapshot deferred into requestIdleCallback (F01)', () => {
    const emits: unknown[] = [];
    const surface = makeSurface((doc) => emits.push(doc));

    schedule(surface);
    vi.advanceTimersByTime(400); // debounce fires -> defers into idle
    expect(emits).toHaveLength(0); // still pending; idle callback captured, not run
    expect(idleCallbacks).toHaveLength(1);

    surface.flush();
    expect(emits).toHaveLength(1); // ⌘S / quit inside the idle window gets fresh bytes
    expect(cancelIdle).toHaveBeenCalledTimes(1); // the deferred emit was cancelled
  });

  it('flush() is idempotent: a second drain with nothing pending is a no-op', () => {
    const emits: unknown[] = [];
    const surface = makeSurface((doc) => emits.push(doc));

    schedule(surface);
    vi.advanceTimersByTime(400);
    surface.flush();
    surface.flush(); // e.g. closeTab flush then the unmount flush
    expect(emits).toHaveLength(1);
  });

  it('flush() before the debounce fires still drains synchronously', () => {
    const emits: unknown[] = [];
    const surface = makeSurface((doc) => emits.push(doc));

    schedule(surface);
    // No timer advance: we are inside the 400ms debounce, timer still live.
    surface.flush();
    expect(emits).toHaveLength(1);
    // The captured idle callback (if any) must not double-emit later.
    idleCallbacks.forEach((cb) => cb());
    expect(emits).toHaveLength(1);
  });

  it('flush() with no pending edit does nothing', () => {
    const emits: unknown[] = [];
    const surface = makeSurface((doc) => emits.push(doc));
    surface.flush();
    expect(emits).toHaveLength(0);
  });

  it('destroy() cancels the deferred idle emit so it cannot fire after teardown (F03)', () => {
    const emits: unknown[] = [];
    const surface = makeSurface((doc) => emits.push(doc));

    schedule(surface);
    vi.advanceTimersByTime(400); // deferred into idle
    surface.destroy();
    // The fix is cancelling the browser's pending idle callback (the leak F03
    // describes). Unlike flush(), destroy() does not emit — teardown drops the
    // pending edit; the caller flushes first if it wants it saved.
    expect(cancelIdle).toHaveBeenCalledWith(1);
    expect(emits).toHaveLength(0);
  });

  it('a deferred idle emit fires normally when left to run (no flush)', () => {
    const emits: unknown[] = [];
    const surface = makeSurface((doc) => emits.push(doc));

    schedule(surface);
    vi.advanceTimersByTime(400);
    expect(emits).toHaveLength(0);
    idleCallbacks.forEach((cb) => cb()); // idle gap arrives
    expect(emits).toHaveLength(1);
  });
});
