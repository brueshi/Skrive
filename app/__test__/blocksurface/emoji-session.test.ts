// @vitest-environment jsdom
//
// The `:` emoji session. The riskiest part of this feature is not the picker but
// the trigger: ordinary prose is full of colons, and a menu that flashes on
// "3:30" or "https://" would make the editor feel possessed.
//
// The defence is inherited rather than invented — the same word-boundary rule
// the `#` tag session uses. These tests pin it directly, because it is the thing
// most likely to be "simplified" later by someone who has not hit the failure.
//
// jsdom dispatches no real beforeinput, so onBeforeInput is driven directly, as
// the tag-autocomplete and word-line-delete suites do.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface, type EmojiMenuState } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';
import { inlinePlainText } from '../../src/lib/blocksurface/inline-ops';
import { setCaret } from '../../src/lib/blocksurface/selection';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  // jsdom implements no layout, so a Range cannot measure itself. The session
  // reads a rect purely to anchor the popover; a stub of nonzero size is enough
  // (the tag-autocomplete suite does the same).
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 1, height: 1, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});
afterEach(() => container.remove());

function beforeInput(surface: BlockSurface, inputType: string, data?: string): void {
  (surface as unknown as { onBeforeInput: (e: Event) => void }).onBeforeInput({
    inputType,
    data,
    preventDefault() {}
  } as unknown as Event);
}
/** Type a string one character at a time, the way the session actually sees it. */
function type(surface: BlockSurface, text: string): void {
  for (const ch of text) beforeInput(surface, 'insertText', ch);
}
function paraText(surface: BlockSurface): string {
  const p = surface.getDocument().blocks.find((b: BlockNode) => b.type === 'paragraph');
  if (!p || p.type !== 'paragraph') throw new Error('no paragraph');
  return inlinePlainText(p.inline);
}

/** Mount a surface with an empty paragraph, watching the emoji menu state. */
function mount(doc = '\n', caretAt = 0) {
  const surface = new BlockSurface({ container, doc: parseDocument(doc) });
  let state: EmojiMenuState | null = null;
  surface.onEmojiMenu((s) => {
    state = s;
  });
  setCaret(container.querySelector('p')!, caretAt);
  return { surface, get state() { return state; } };
}

describe('opening on a typed colon', () => {
  it('opens at the start of a block, once a character follows', () => {
    const m = mount();
    type(m.surface, ':');
    expect(m.state, 'a bare colon shows nothing yet').toBeNull();
    type(m.surface, 's');
    expect(m.state?.query).toBe('s');
    expect(m.state?.seeded).toBe(false);
  });

  it('opens after a space', () => {
    const m = mount('hi\n', 2);
    type(m.surface, ' :sm');
    expect(m.state?.query).toBe('sm');
  });

  it('tracks the query as it grows', () => {
    const m = mount();
    type(m.surface, ':smi');
    expect(m.state?.query).toBe('smi');
    type(m.surface, 'l');
    expect(m.state?.query).toBe('smil');
  });
});

// The whole reason a `:` trigger is safe in prose. Each of these has a non-space
// character before the colon, so no session ever opens.
describe('ordinary prose colons never open a session', () => {
  it('ignores a time like 3:30', () => {
    const m = mount();
    type(m.surface, '3:30');
    expect(m.state).toBeNull();
    expect(paraText(m.surface)).toBe('3:30');
  });

  it('ignores a colon after a word, as in "note: this"', () => {
    const m = mount();
    type(m.surface, 'note:');
    expect(m.state).toBeNull();
    type(m.surface, ' this');
    expect(m.state).toBeNull();
    expect(paraText(m.surface)).toBe('note: this');
  });

  it('ignores a URL scheme', () => {
    const m = mount();
    type(m.surface, 'https:');
    expect(m.state).toBeNull();
  });
});

describe('closing', () => {
  it('closes on a space, leaving the colon literal', () => {
    const m = mount();
    type(m.surface, ':sm');
    expect(m.state).not.toBeNull();
    type(m.surface, ' ');
    expect(m.state).toBeNull();
    expect(paraText(m.surface)).toBe(':sm ');
  });

  it('closes on punctuation, so an emoticon stays text', () => {
    const m = mount('hi\n', 2);
    type(m.surface, ' :)');
    expect(m.state).toBeNull();
    expect(paraText(m.surface)).toBe('hi :)');
  });

  it('closeEmoji() clears the observer', () => {
    const m = mount();
    type(m.surface, ':sm');
    m.surface.closeEmoji();
    expect(m.state).toBeNull();
  });
});

describe('the query tracks deletes, not just inserts', () => {
  it('narrows the query on Backspace', () => {
    const m = mount();
    type(m.surface, ':smi');
    expect(m.state?.query).toBe('smi');
    beforeInput(m.surface, 'deleteContentBackward');
    expect(m.state?.query).toBe('sm');
  });

  it('hides the grid again when the query empties back to a bare colon', () => {
    const m = mount();
    type(m.surface, ':s');
    expect(m.state).not.toBeNull();
    beforeInput(m.surface, 'deleteContentBackward');
    expect(m.state).toBeNull();
  });
});

describe('a seeded session (the Insert catalog route)', () => {
  it('types the colon and opens on an empty query', () => {
    const m = mount();
    m.surface.openEmojiPicker();
    expect(m.state?.seeded).toBe(true);
    expect(m.state?.query).toBe('');
    expect(paraText(m.surface)).toBe(':');
  });

  it('opens mid-word, where a typed colon deliberately would not', () => {
    const m = mount('note\n', 4);
    m.surface.openEmojiPicker();
    expect(m.state?.seeded).toBe(true);
    expect(paraText(m.surface)).toBe('note:');
  });
});

describe('committing', () => {
  it('replaces the typed :query with the character', () => {
    const m = mount();
    type(m.surface, ':smile');
    m.surface.applyEmojiCommand('😄');
    expect(paraText(m.surface)).toBe('😄');
    expect(m.state).toBeNull();
  });

  it('leaves surrounding prose intact', () => {
    const m = mount('hi\n', 2);
    type(m.surface, ' :wave');
    m.surface.applyEmojiCommand('👋');
    expect(paraText(m.surface)).toBe('hi 👋');
  });

  it('adds no trailing space — an emoji is a character, not a chip', () => {
    const m = mount();
    type(m.surface, ':smile');
    m.surface.applyEmojiCommand('😄');
    expect(paraText(m.surface)).toBe('😄');
  });

  it('is one undo step, restoring the literal :query', () => {
    const m = mount();
    type(m.surface, ':smile');
    m.surface.applyEmojiCommand('😄');
    expect(paraText(m.surface)).toBe('😄');
    m.surface.undo();
    expect(paraText(m.surface)).toBe(':smile');
  });

  it('does nothing when no session is open', () => {
    const m = mount('hi\n', 2);
    m.surface.applyEmojiCommand('😄');
    expect(paraText(m.surface)).toBe('hi');
  });
});
