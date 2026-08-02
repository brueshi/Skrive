// @vitest-environment jsdom
//
// One press deletes one emoji. Inline offsets are UTF-16 code units, so before
// this the delete paths stepped by one unit and left a lone surrogate behind —
// invalid text that reaches the serializer and the file on disk, not just a
// rendering glitch.
//
// The check every case makes is the same: after the delete, the text is exactly
// what it should be AND contains no unpaired surrogate. The second half is the
// one that catches a half-deleted emoji, since a broken pair still renders as
// "something" and a length assertion alone can pass on garbage.
//
// jsdom dispatches no real beforeinput for a simulated keypress, so onBeforeInput
// is driven directly, as word-line-delete.test.ts does.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';
import { inlinePlainText } from '../../src/lib/blocksurface/inline-ops';
import { setCaret } from '../../src/lib/blocksurface/selection';

const GRIN = '\u{1F600}'; // 2 code units
const THUMB_TONE = '\u{1F44D}\u{1F3FD}'; // 4
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 8, ZWJ-joined

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function beforeInput(surface: BlockSurface, inputType: string): void {
  (surface as unknown as { onBeforeInput: (e: Event) => void }).onBeforeInput({
    inputType,
    preventDefault() {}
  } as unknown as Event);
}
function blocksOf(surface: BlockSurface): BlockNode[] {
  return surface.getDocument().blocks;
}
function paraText(surface: BlockSurface): string {
  const p = blocksOf(surface).find((b) => b.type === 'paragraph');
  if (!p || p.type !== 'paragraph') throw new Error('no paragraph');
  return inlinePlainText(p.inline);
}
function codeText(surface: BlockSurface): string {
  const c = blocksOf(surface).find((b) => b.type === 'code_block');
  if (!c || c.type !== 'code_block') throw new Error('no code block');
  return c.text;
}
function cell00(surface: BlockSurface): string {
  const t = blocksOf(surface).find((b) => b.type === 'table');
  if (!t || t.type !== 'table') throw new Error('no table');
  return inlinePlainText(t.rows[0]![0]!);
}

/** True when the string contains a surrogate that is not part of a valid pair —
 *  the exact corruption a code-unit-sized delete produces. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('Backspace over an emoji in prose', () => {
  it('removes a surrogate-pair emoji whole, in one press', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`a${GRIN}\n`) });
    setCaret(container.querySelector('p')!, 1 + GRIN.length);
    beforeInput(surface, 'deleteContentBackward');
    expect(paraText(surface)).toBe('a');
    expect(hasLoneSurrogate(paraText(surface))).toBe(false);
  });

  it('removes a skin-toned emoji whole, modifier included', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`x${THUMB_TONE}\n`) });
    setCaret(container.querySelector('p')!, 1 + THUMB_TONE.length);
    beforeInput(surface, 'deleteContentBackward');
    expect(paraText(surface)).toBe('x');
  });

  it('removes a ZWJ sequence in one press, not eleven', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`x${FAMILY}\n`) });
    setCaret(container.querySelector('p')!, 1 + FAMILY.length);
    beforeInput(surface, 'deleteContentBackward');
    expect(paraText(surface)).toBe('x');
    expect(hasLoneSurrogate(paraText(surface))).toBe(false);
  });

  it('leaves following text untouched when deleting mid-string', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`a${GRIN}b\n`) });
    setCaret(container.querySelector('p')!, 1 + GRIN.length);
    beforeInput(surface, 'deleteContentBackward');
    expect(paraText(surface)).toBe('ab');
  });

  it('still deletes a plain character one at a time', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    setCaret(container.querySelector('p')!, 3);
    beforeInput(surface, 'deleteContentBackward');
    expect(paraText(surface)).toBe('ab');
  });
});

describe('Delete (forward) over an emoji in prose', () => {
  it('removes a surrogate-pair emoji whole', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${GRIN}b\n`) });
    setCaret(container.querySelector('p')!, 0);
    beforeInput(surface, 'deleteContentForward');
    expect(paraText(surface)).toBe('b');
    expect(hasLoneSurrogate(paraText(surface))).toBe(false);
  });

  it('removes a ZWJ sequence whole', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${FAMILY}b\n`) });
    setCaret(container.querySelector('p')!, 0);
    beforeInput(surface, 'deleteContentForward');
    expect(paraText(surface)).toBe('b');
  });

  it('still deletes a plain character one at a time', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    setCaret(container.querySelector('p')!, 0);
    beforeInput(surface, 'deleteContentForward');
    expect(paraText(surface)).toBe('bc');
  });
});

describe('Backspace over an emoji in a code block', () => {
  it('removes it whole', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`\`\`\`\nx${GRIN}\n\`\`\`\n`) });
    const code = container.querySelector('code, pre')!;
    setCaret(code as HTMLElement, 1 + GRIN.length);
    beforeInput(surface, 'deleteContentBackward');
    expect(codeText(surface)).toBe('x');
    expect(hasLoneSurrogate(codeText(surface))).toBe(false);
  });
});

describe('Backspace over an emoji in a table cell', () => {
  it('removes it whole', () => {
    const surface = new BlockSurface({
      container,
      doc: parseDocument(`| a${GRIN} | b |\n| --- | --- |\n| c | d |\n`)
    });
    const cell = container.querySelector('th, td')!;
    setCaret(cell as HTMLElement, 1 + GRIN.length);
    beforeInput(surface, 'deleteContentBackward');
    expect(cell00(surface)).toBe('a');
    expect(hasLoneSurrogate(cell00(surface))).toBe(false);
  });
});

// The model and the DOM must remove the same number of code units. If the
// surgical fast path took one unit while the model took two, the two would
// silently diverge — worse than the original bug, since the next edit reads a
// DOM that no longer matches the document.
describe('model and DOM agree after the delete', () => {
  it('the rendered text matches the model', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`ab${GRIN}cd\n`) });
    const p = container.querySelector('p')!;
    setCaret(p, 2 + GRIN.length);
    beforeInput(surface, 'deleteContentBackward');
    expect(paraText(surface)).toBe('abcd');
    expect(p.textContent).toBe('abcd');
  });
});
