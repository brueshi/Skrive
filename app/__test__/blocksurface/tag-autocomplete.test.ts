// @vitest-environment jsdom
//
// The inline-tag (`#`) autocomplete session on the surface: opening at a word
// boundary, tracking the query, committing an InlineTag leaf, and staying out of
// the way of the `# ` heading rule. Drives the real surface (as input-rules.test)
// and reads the model back; the popover's presentation is the React component's.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface, type TagMenuState } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 1, height: 1, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});
afterEach(() => container.remove());

type Driver = { applyInsertText: (t: string) => void };
const drive = (s: BlockSurface): Driver => s as unknown as Driver;

const para = (surface: BlockSurface): BlockNode => surface.getDocument().blocks[0]!;
function inlineOf(surface: BlockSurface): InlineNode[] {
  const b = para(surface);
  if (b.type !== 'paragraph' && b.type !== 'heading') throw new Error(`expected inline block, got ${b.type}`);
  return b.inline;
}
const text = (t: string, marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'text', text: t, marks });
const tag = (name: string, marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'tag', name, marks });

// Place the caret at a flat offset in the (single-text-node) first paragraph, then
// type each character through the real insert path.
function caretAtEnd(surface: BlockSurface): void {
  const p = container.querySelector('p, h1, h2, h3, h4, h5, h6')!;
  const tn = p.firstChild!;
  window.getSelection()!.collapse(tn, (tn.textContent ?? '').length);
}
function type(surface: BlockSurface, s: string): void {
  for (const ch of s) drive(surface).applyInsertText(ch);
}

describe('opening the tag session', () => {
  it('opens after whitespace and tracks the query', () => {
    let last: TagMenuState | null = null;
    let opens = 0;
    const surface = new BlockSurface({ container, doc: parseDocument('note\n') });
    surface.onTagMenu((s) => {
      last = s;
      if (s && s.query === '') opens++;
    });
    caretAtEnd(surface);
    type(surface, ' #to');

    expect(opens).toBe(1); // opened once, at the `#`
    expect(last).not.toBeNull();
    expect(last!.query).toBe('to');
  });

  it('does not open when the # follows a non-space (C# / mid-word)', () => {
    let last: TagMenuState | null = null;
    const surface = new BlockSurface({ container, doc: parseDocument('note\n') });
    surface.onTagMenu((s) => (last = s));
    caretAtEnd(surface);
    type(surface, '#tag'); // '#' directly after "note"

    expect(last).toBeNull();
  });

  it('closes when a non-tag character follows the #', () => {
    let last: TagMenuState | null = null;
    const surface = new BlockSurface({ container, doc: parseDocument('note\n') });
    surface.onTagMenu((s) => (last = s));
    caretAtEnd(surface);
    type(surface, ' #');
    expect(last).not.toBeNull();
    type(surface, '.'); // '.' is not a tag-name char
    expect(last).toBeNull();
  });
});

describe('committing a tag', () => {
  it('splices a tag leaf in place of the typed #query, with a trailing space', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('note\n') });
    caretAtEnd(surface);
    type(surface, ' #todo');
    surface.applyTagCommand('todo');

    expect(inlineOf(surface)).toEqual([text('note '), tag('todo'), text(' ')]);
  });

  it('commits an existing suggestion name, not the partial query', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('note\n') });
    caretAtEnd(surface);
    type(surface, ' #pro');
    surface.applyTagCommand('project/q3'); // an existing tag chosen from the list

    expect(inlineOf(surface)).toEqual([text('note '), tag('project/q3'), text(' ')]);
  });

  it('does not double the space when text already follows', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('a  b\n') });
    // Caret between the two spaces: "a " | " b".
    const tn = container.querySelector('p')!.firstChild!;
    window.getSelection()!.collapse(tn, 2);
    type(surface, '#todo');
    surface.applyTagCommand('todo');

    // No trailing space inserted — the existing space after the caret suffices.
    expect(inlineOf(surface)).toEqual([text('a '), tag('todo'), text(' b')]);
  });
});

describe('the heading rule keeps priority', () => {
  it('"# " makes a heading and does not leave a tag session open', () => {
    let last: TagMenuState | null = null;
    const surface = new BlockSurface({ container, doc: parseDocument('world\n') });
    surface.onTagMenu((s) => (last = s));
    const tn = container.querySelector('p')!.firstChild!;
    window.getSelection()!.collapse(tn, 0);
    drive(surface).applyInsertText('#'); // opens a session at the block start
    expect(last).not.toBeNull();
    window.getSelection()!.collapse(container.querySelector('p')!.firstChild!, 1);
    drive(surface).applyInsertText(' '); // the heading rule fires

    expect(para(surface).type).toBe('heading');
    expect(last).toBeNull(); // the session was closed, not left stale
  });
});
