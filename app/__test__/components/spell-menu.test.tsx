// @vitest-environment jsdom
//
// The spelling correction menu. What matters here is that a correction lands in
// the model through the surface's own replace primitive (not a DOM edit behind
// it), that the two "keep this word" actions route to the right place — Skrive's
// personal dictionary for good, the oracle's session ignore for now — and that
// suggestions are asked for only when the menu opens.
//
// Follows block-slash-menu.test.tsx: a real BlockSurface plus createRoot, no
// testing-library.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../jsdom-range-rect';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import React from 'react';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument } from '../../src/lib/blockmodel';
import { SpellMenu, type SpellMenuTarget } from '../../src/components/editor/menus/SpellMenu';
import type { SpellcheckHandle } from '../../src/lib/spellcheck/checker';
import { usePreferencesStore } from '../../src/stores/preferences';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let mountEl: HTMLElement;
let root: Root | null = null;

/** A checker façade that records what the menu asked it to do. */
function fakeSpellcheck(suggestions: string[]) {
  const calls = { suggested: [] as string[], ignored: [] as string[] };
  const handle: SpellcheckHandle = {
    misspellingAt: () => null,
    invalidateAll: () => {},
    repaint: () => {},
    suggest: (word) => {
      calls.suggested.push(word);
      return Promise.resolve(suggestions);
    },
    ignore: (word) => {
      calls.ignored.push(word);
      return Promise.resolve();
    },
    destroy: () => {}
  };
  return { handle, calls };
}

beforeEach(() => {
  host = document.createElement('div');
  mountEl = document.createElement('div');
  document.body.append(host, mountEl);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  mountEl.remove();
  document.body.innerHTML = '';
});

/** Mount the menu over a one-paragraph document and open it on `word`. */
async function open(
  text: string,
  word: string,
  suggestions: string[]
): Promise<{
  surface: BlockSurface;
  calls: ReturnType<typeof fakeSpellcheck>['calls'];
  close: () => void;
  closed: () => boolean;
}> {
  const surface = new BlockSurface({ container: host, doc: parseDocument(`${text}\n`) });
  const block = surface.getDocument().blocks[0];
  if (!block) throw new Error('no block');
  const start = text.indexOf(word);
  const target: SpellMenuTarget = {
    blockId: block.id,
    start,
    end: start + word.length,
    word,
    x: 40,
    y: 60
  };
  const { handle, calls } = fakeSpellcheck(suggestions);
  let wasClosed = false;
  const onClose = (): void => {
    wasClosed = true;
  };
  root = createRoot(mountEl);
  await act(async () => {
    root!.render(
      React.createElement(SpellMenu, { surface, spellcheck: handle, target, onClose })
    );
  });
  return { surface, calls, close: onClose, closed: () => wasClosed };
}

function itemLabelled(label: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('.spell-menu .rich-slash-item')).find(
    (el) => el.textContent === label
  );
  if (!found) throw new Error(`no menu item labelled "${label}"`);
  return found;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
}

describe('SpellMenu', () => {
  it('asks the oracle about the opened word, once', async () => {
    const { calls } = await open('the teh cat', 'teh', ['the', 'ten']);
    expect(calls.suggested).toEqual(['teh']);
    expect(itemLabelled('the')).toBeTruthy();
    expect(itemLabelled('ten')).toBeTruthy();
  });

  it('a suggestion replaces the word in the model', async () => {
    const { surface, closed } = await open('the teh cat', 'teh', ['the']);
    click(itemLabelled('the'));

    const block = surface.getDocument().blocks[0];
    if (!block || block.type !== 'paragraph') throw new Error('expected a paragraph');
    expect(block.inline).toEqual([{ kind: 'text', text: 'the the cat', marks: {} }]);
    expect(closed()).toBe(true);
  });

  it('Add to dictionary teaches Skrive, not the platform', async () => {
    const spy = vi.spyOn(usePreferencesStore.getState(), 'addDictionaryWord');
    const { calls } = await open('about Atticus today', 'Atticus', []);
    click(itemLabelled('Add to dictionary'));

    expect(spy).toHaveBeenCalledWith('Atticus');
    expect(calls.ignored).toEqual([]);
    spy.mockRestore();
  });

  it('Ignore goes to the oracle for the session only', async () => {
    const spy = vi.spyOn(usePreferencesStore.getState(), 'addDictionaryWord');
    const { calls } = await open('about Atticus today', 'Atticus', []);
    click(itemLabelled('Ignore'));

    expect(calls.ignored).toEqual(['Atticus']);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('says so when the oracle has nothing to offer', async () => {
    await open('the teh cat', 'teh', []);
    expect(document.querySelector('.spell-menu .rich-slash-empty')?.textContent).toBe('No suggestions');
  });
});
