// @vitest-environment jsdom
//
// BlockSlashMenu keyboard/state behavior (SKR-172). Two of the three session
// bugs this ticket fixes live entirely in this component rather than in
// surface.ts: the zero-match trap (F68 — Enter/arrows preventDefault'ed into
// `items[undefined]` no-ops while nothing rendered to navigate, with Escape or
// deleting back the only way out) and the reopen-highlight papercut (the
// previous session's active row carried over instead of resetting to the
// first item). Both need a real render plus real keydown dispatch to
// exercise, so this drives an actual BlockSurface + a real createRoot render
// (no testing-library — react-dom/client + react's own `act` are enough, and
// the repo has no existing component-test precedent to match instead).
//
// The other SKR-172 fix (applySlashCommand refusing a stale caret, and the
// selection-observer close that backs it) lives in surface.ts and is covered
// by __test__/blocksurface/slash-menu.test.ts instead.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../jsdom-range-rect';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import React from 'react';
import { BlockSurface } from '../../src/lib/blocksurface';
import { generateBlockId, type BlockNode, type Document } from '../../src/lib/blockmodel';
import { setCaret } from '../../src/lib/blocksurface/selection';
import { BlockSlashMenu } from '../../src/components/editor/menus/BlockSlashMenu';

// No test-runner integration (no testing-library) sets this for us; without it
// React logs an "environment not configured for act" warning on every act() call.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement; // the surface's own contenteditable — also the real keydown target
let mountEl: HTMLElement; // where the menu's own React tree mounts (it portals to <body>)
let root: Root | null = null;

function paragraph(text: string): BlockNode {
  return {
    type: 'paragraph',
    id: generateBlockId(),
    durable: false,
    src: null,
    gapBefore: null,
    dirty: false,
    inline: text ? [{ kind: 'text', text, marks: {} }] : []
  } as BlockNode;
}
function docOf(...texts: string[]): Document {
  return { blocks: texts.map(paragraph), trailingGap: '\n' };
}
// A single top-level bullet list, one item per text (an empty string yields an
// empty item paragraph) — the container shape the SKR-218 tests below open a
// slash session inside.
function bulletListDoc(...texts: string[]): Document {
  const list: BlockNode = {
    type: 'bullet_list',
    id: generateBlockId(),
    durable: false,
    src: null,
    gapBefore: null,
    dirty: false,
    marker: '-',
    spread: false,
    items: texts.map((t) => ({ spread: false, children: [paragraph(t)] }))
  } as BlockNode;
  return { blocks: [list], trailingGap: '\n' };
}
// One applyInsertText call per character — handleSlashAfterInsert only opens a
// session when the inserted text is exactly '/', so a batched string would
// never trigger it.
function type(surface: BlockSurface, text: string): void {
  const apply = (surface as unknown as { applyInsertText: (t: string) => void }).applyInsertText.bind(surface);
  act(() => {
    for (const ch of text) apply(ch);
  });
}
function backspace(surface: BlockSurface): void {
  const del = (surface as unknown as { applyDeleteBackward: () => void }).applyDeleteBackward.bind(surface);
  act(() => del());
}
// Dispatched on `host` (the real keydown target, matching production): the
// capturing phase visits document — where the menu's own listener lives —
// before it reaches host's own listener (the surface's onKeyDown), the same
// order a real browser keydown resolves in.
function key(k: string): void {
  act(() => {
    host.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}
function items(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.rich-slash-item'));
}
function activeTitle(): string | null {
  return document.querySelector('.rich-slash-item.active .rich-slash-title')?.textContent ?? null;
}
function emptyRow(): HTMLElement | null {
  return document.querySelector('.rich-slash-empty');
}
function slashOf(surface: BlockSurface): unknown {
  return (surface as unknown as { slash: unknown }).slash;
}
function closeSlashOnSelectionMove(surface: BlockSurface): void {
  (surface as unknown as { closeSlashOnSelectionMove: () => void }).closeSlashOnSelectionMove();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  mountEl = document.createElement('div');
  document.body.appendChild(mountEl);
});
afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  host.remove();
  mountEl.remove();
  // The menu portals to document.body; unmount() should already have cleared
  // it, but a leftover node would leak into (and confuse) the next test.
  document.querySelectorAll('.rich-slash-menu').forEach((n) => n.remove());
});

function mount(surface: BlockSurface): void {
  root = createRoot(mountEl);
  act(() => {
    root!.render(React.createElement(BlockSlashMenu, { surface }));
  });
}

describe('zero-match query (SKR-172 / F68)', () => {
  it('renders a quiet "No matches" row instead of nothing', () => {
    const surface = new BlockSurface({ container: host, doc: docOf('') });
    mount(surface);
    setCaret(host.querySelector('p')!, 0);

    type(surface, '/xq');

    expect(items().length).toBe(0);
    expect(emptyRow()?.textContent).toBe('No matches');
  });

  it('lets Enter fall through to normal editing (the block splits) instead of no-oping', () => {
    const surface = new BlockSurface({ container: host, doc: docOf('') });
    mount(surface);
    setCaret(host.querySelector('p')!, 0);
    type(surface, '/xq');

    key('Enter');

    expect(surface.getDocument().blocks.length).toBe(2); // Enter really split the block
  });

  it('lets arrow keys fall through without throwing or being swallowed', () => {
    const surface = new BlockSurface({ container: host, doc: docOf('') });
    mount(surface);
    setCaret(host.querySelector('p')!, 0);
    type(surface, '/xq');

    expect(() => key('ArrowDown')).not.toThrow();
    expect(() => key('ArrowUp')).not.toThrow();
    // Session is still open (only Enter/Escape/deleting back end it) and
    // still shows the empty state, not a crash.
    expect(emptyRow()?.textContent).toBe('No matches');
  });

  it('Escape still closes even with zero matches', () => {
    const surface = new BlockSurface({ container: host, doc: docOf('') });
    mount(surface);
    setCaret(host.querySelector('p')!, 0);
    type(surface, '/xq');

    key('Escape');

    // The session's own state is the source of truth here — AnimatePresence
    // keeps the row mounted through its (unrelated) exit transition, so DOM
    // presence isn't a reliable signal for "closed" on this tight a timescale.
    expect(slashOf(surface)).toBeNull();
  });

  it('deleting back to a matching query re-shows the list live', () => {
    const surface = new BlockSurface({ container: host, doc: docOf('') });
    mount(surface);
    setCaret(host.querySelector('p')!, 0);
    type(surface, '/xq');
    expect(items().length).toBe(0);

    backspace(surface); // '/xq' -> '/x'
    backspace(surface); // '/x'  -> '/'  (matches everything again)

    expect(emptyRow()).toBeNull();
    expect(items().length).toBeGreaterThan(0);
  });
});

describe('reopen resets the highlighted row (SKR-172 papercut)', () => {
  it('does not carry the previous session\'s active index into a reopen', () => {
    const surface = new BlockSurface({ container: host, doc: docOf('', '') });
    mount(surface);
    const [p1, p2] = Array.from(host.querySelectorAll('p'));

    setCaret(p1!, 0);
    type(surface, '/');
    expect(activeTitle()).toBe('Text'); // first item on open

    key('ArrowDown');
    key('ArrowDown');
    expect(activeTitle()).not.toBe('Text'); // moved off the first item

    key('Escape'); // close
    expect(slashOf(surface)).toBeNull();

    setCaret(p2!, 0);
    type(surface, '/'); // reopen, a fresh session in a different block

    expect(activeTitle()).toBe('Text'); // reset, not carried over
  });
});

describe('a normal slash flow end to end', () => {
  it('opens, filters as the query narrows, and Enter applies to the slash block', () => {
    const surface = new BlockSurface({ container: host, doc: docOf('') });
    mount(surface);
    setCaret(host.querySelector('p')!, 0);

    type(surface, '/');
    expect(items().length).toBeGreaterThan(1);

    type(surface, 'divi'); // narrows to "Divider"
    expect(items().map((el) => el.querySelector('.rich-slash-title')?.textContent)).toEqual(['Divider']);

    key('Enter');

    expect(surface.getDocument().blocks[0]!.type).toBe('horizontal_rule');
    expect(slashOf(surface)).toBeNull();
  });
});

// The opener resolves a nested leaf (a list-item paragraph) the same way it
// resolves a top-level one; the menu itself has no idea the leaf is nested —
// it only reads the slash state's rect/query (SKR-218).
describe('opening and filtering inside a list item (SKR-218)', () => {
  it('opens on an empty list item and filters the query the same as at top level', () => {
    const surface = new BlockSurface({ container: host, doc: bulletListDoc('alpha', '') });
    mount(surface);
    const listItems = host.querySelectorAll<HTMLElement>('li p');
    setCaret(listItems[1]!, 0);

    type(surface, '/');
    expect(items().length).toBeGreaterThan(1);

    type(surface, 'divi');
    expect(items().map((el) => el.querySelector('.rich-slash-title')?.textContent)).toEqual(['Divider']);

    key('Enter');

    const blocks = surface.getDocument().blocks;
    // Divider inserts AFTER the enclosing list (SKR-169); the item that hosted
    // the session stays in the list, query stripped.
    expect(blocks.map((b) => b.type)).toEqual(['bullet_list', 'horizontal_rule', 'paragraph']);
    expect(slashOf(surface)).toBeNull();
  });
});

describe('zero-match query inside a container (SKR-218)', () => {
  it('lets Enter fall through to a normal item split instead of no-oping', () => {
    const surface = new BlockSurface({ container: host, doc: bulletListDoc('') });
    mount(surface);
    const listItems = host.querySelectorAll<HTMLElement>('li p');
    setCaret(listItems[0]!, 0);
    type(surface, '/xq');

    expect(items().length).toBe(0);
    expect(emptyRow()?.textContent).toBe('No matches');

    key('Enter');

    const list = surface.getDocument().blocks[0] as unknown as { items: unknown[] };
    expect(list.items).toHaveLength(2); // the item really split, not swallowed

    // The observer (rAF-scheduled off the real selectionchange event in
    // production) is what notices the caret landed on the new item's leaf,
    // not the stale slash block — exercised directly here, as the surface-level
    // suite does, rather than round-tripping a timing-dependent DOM event.
    closeSlashOnSelectionMove(surface);
    expect(slashOf(surface)).toBeNull();
  });
});
