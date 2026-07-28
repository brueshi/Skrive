// @vitest-environment jsdom
//
// The spellcheck controller against a fake oracle: what gets asked, when, and
// which answers survive as squiggles. The host checker is deliberately not in
// the loop here — everything worth testing (debouncing, caching by text,
// dictionary layering, the caret courtesy, staleness) is Skrive's half.
//
// jsdom implements no box geometry, so every block reports a zero rect and the
// viewport scoping degenerates to "everything is visible" — which is what makes
// the rest observable in a unit test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument } from '../../src/lib/blockmodel';
import { attachSpellcheck, type SpellcheckHandle } from '../../src/lib/spellcheck/checker';
import { SpellDictionary } from '../../src/lib/spellcheck/dictionary';
import type { SpellProvider } from '../../src/lib/spellcheck/provider';
import type { SpellCheckRequest, SpellCheckResult } from '@skrive/shared';

/** An oracle that flags exactly the words it is told to, wherever they appear. */
function fakeProvider(misspelled: string[]) {
  const asked: SpellCheckRequest[][] = [];
  const provider: SpellProvider = {
    check(requests) {
      asked.push(requests.map((r) => ({ ...r })));
      const results: SpellCheckResult[] = requests.map((request) => {
        const ranges = [];
        for (const word of misspelled) {
          let from = 0;
          for (;;) {
            const at = request.text.indexOf(word, from);
            if (at === -1) break;
            ranges.push({ start: at, end: at + word.length });
            from = at + word.length;
          }
        }
        ranges.sort((a, b) => a.start - b.start);
        return { id: request.id, ranges };
      });
      return Promise.resolve(results);
    },
    suggest: () => Promise.resolve([]),
    learn: () => Promise.resolve(),
    ignore: () => Promise.resolve()
  };
  return { provider, asked };
}

let container: HTMLElement;
let scroller: HTMLElement;
let handle: SpellcheckHandle | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  scroller = document.createElement('div');
  container = document.createElement('div');
  scroller.appendChild(container);
  document.body.appendChild(scroller);
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  scroller.remove();
  vi.useRealTimers();
});

type AttachOptions = { dictionary?: SpellDictionary };

function attach(
  surface: BlockSurface,
  provider: SpellProvider,
  { dictionary = new SpellDictionary([], []) }: AttachOptions = {}
): SpellcheckHandle {
  handle = attachSpellcheck({
    surface: container,
    scroller,
    blockSurface: surface,
    provider,
    dictionary: () => dictionary
  });
  return handle;
}

/** The id of the document's first block — every fixture here is one paragraph
 *  deep, and index access is checked in this project. */
function firstBlockId(surface: BlockSurface): string {
  const block = surface.getDocument().blocks[0];
  if (!block) throw new Error('document has no blocks');
  return block.id;
}

/** Run out every pending debounce and let the provider's promises settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000);
}

describe('attachSpellcheck', () => {
  it('paints a misspelling as a decoration on the first pass', async () => {
    const doc = parseDocument('the teh cat\n');
    const surface = new BlockSurface({ container, doc });
    const { provider } = fakeProvider(['teh']);
    attach(surface, provider);

    await settle();

    const id = firstBlockId(surface);
    expect(surface.decorations.forBlock(id)).toEqual([
      { blockId: id, start: 4, end: 7, type: 'misspelling' }
    ]);
  });

  it('asks nothing until typing settles', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('the teh cat\n') });
    const { provider, asked } = fakeProvider(['teh']);
    attach(surface, provider);

    await vi.advanceTimersByTimeAsync(50);
    expect(asked).toHaveLength(0);
    await settle();
    expect(asked).toHaveLength(1);
  });

  it('does not re-ask about text it already checked', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('the teh cat\n') });
    const { provider, asked } = fakeProvider(['teh']);
    attach(surface, provider);
    await settle();
    expect(asked).toHaveLength(1);

    // A scroll repaints from cache; nothing changed, so nothing is asked.
    scroller.dispatchEvent(new Event('scroll'));
    await settle();
    expect(asked).toHaveLength(1);
  });

  it('a dictionary word is never painted', async () => {
    const doc = parseDocument('Atticus walked home\n');
    const surface = new BlockSurface({ container, doc });
    const { provider } = fakeProvider(['Atticus']);
    attach(surface, provider, { dictionary: new SpellDictionary(['atticus'], []) });

    await settle();

    expect(surface.decorations.forBlock(firstBlockId(surface))).toEqual([]);
  });

  it('leaves the word under the caret alone', async () => {
    const doc = parseDocument('the teh cat\n');
    const surface = new BlockSurface({ container, doc });
    const { provider } = fakeProvider(['teh']);
    attach(surface, provider);

    // Caret inside "teh" — the writer is mid-word, not wrong yet.
    const text = container.querySelector('p')!.firstChild!;
    window.getSelection()!.collapse(text, 6);

    await settle();
    const id = firstBlockId(surface);
    expect(surface.decorations.forBlock(id)).toEqual([]);

    // Move away and the judgement lands on the next pass.
    window.getSelection()!.collapse(text, 0);
    handle!.invalidateAll();
    await settle();
    expect(surface.decorations.forBlock(id)).toHaveLength(1);
  });

  it('misspellingAt hit-tests what is painted', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('the teh cat\n') });
    const { provider } = fakeProvider(['teh']);
    const spellcheck = attach(surface, provider);
    await settle();

    const id = firstBlockId(surface);
    expect(spellcheck.misspellingAt(id, 5)).toEqual({ start: 4, end: 7, word: 'teh' });
    expect(spellcheck.misspellingAt(id, 9)).toBeNull();
    expect(spellcheck.misspellingAt('no-such-block', 5)).toBeNull();
  });

  it('drops every cached answer on invalidateAll, so a taught word disappears', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('the teh cat\n') });
    const { provider, asked } = fakeProvider(['teh']);
    attach(surface, provider);
    await settle();
    expect(asked).toHaveLength(1);

    handle!.invalidateAll();
    await settle();
    expect(asked).toHaveLength(2);
  });

  it('clears its squiggles on destroy', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('the teh cat\n') });
    const { provider } = fakeProvider(['teh']);
    const spellcheck = attach(surface, provider);
    await settle();
    const id = firstBlockId(surface);
    expect(surface.decorations.forBlock(id)).toHaveLength(1);

    spellcheck.destroy();
    handle = null;
    expect(surface.decorations.forBlock(id)).toEqual([]);
  });

  it('never paints an answer for text the writer has already changed', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('the teh cat\n') });
    const id = firstBlockId(surface);
    // An oracle that answers only after the document has moved on.
    let release: (() => void) | null = null;
    const provider: SpellProvider = {
      check: (requests) =>
        new Promise((resolve) => {
          release = () =>
            resolve(requests.map((r) => ({ id: r.id, ranges: [{ start: 4, end: 7 }] })));
        }),
      suggest: () => Promise.resolve([]),
      learn: () => Promise.resolve(),
      ignore: () => Promise.resolve()
    };
    attach(surface, provider);
    await vi.advanceTimersByTimeAsync(600);

    // The text is replaced while the answer is in flight; the stale offsets must
    // not be painted onto the new text.
    surface.replaceMatch(id, 0, 11, 'entirely different words');
    release!();
    await settle();

    expect(surface.decorations.forBlock(firstBlockId(surface))).toEqual([]);
  });
});
