// @vitest-environment jsdom
//
// Tab + Markdown marker input rules (SKR-188 / F53, F76). Tab in a plain paragraph
// inserts two spaces instead of throwing focus to the chrome; the `- `/`# ` marker
// rules fire inside a blockquote (not just at top level) and now include headings,
// while leaving an existing list item's literal marker alone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 1, height: 1, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});
afterEach(() => container.remove());

type Driver = { applyInsertText: (t: string) => void; onKeyDown: (e: Event) => void };
const drive = (s: BlockSurface): Driver => s as unknown as Driver;

function collapse(node: Node, offset: number): void {
  window.getSelection()!.collapse(node, offset);
}
function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  drive(surface).onKeyDown(e);
  return e;
}
function blocks(surface: BlockSurface): BlockNode[] {
  return surface.getDocument().blocks;
}

describe('Tab in a plain paragraph (SKR-188)', () => {
  it('inserts two spaces and claims the key (no focus escape, no split)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hi\n') });
    collapse(container.querySelector('p')!.firstChild!, 2);
    const e = key(surface, { key: 'Tab' });

    expect(e.defaultPrevented).toBe(true);
    expect(blocks(surface)).toHaveLength(1);
    const p = blocks(surface)[0]!;
    expect(p.type === 'paragraph' && p.inline[0]?.kind === 'text' && p.inline[0].text).toBe('hi  ');
  });

  it('Shift+Tab is a claimed no-op (still consumes the key)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hi\n') });
    collapse(container.querySelector('p')!.firstChild!, 2);
    const e = key(surface, { key: 'Tab', shiftKey: true });

    expect(e.defaultPrevented).toBe(true);
    const p = blocks(surface)[0]!;
    expect(p.type === 'paragraph' && p.inline[0]?.kind === 'text' && p.inline[0].text).toBe('hi');
  });
});

describe('heading input rule (SKR-188)', () => {
  it('"# " converts a paragraph to H1, consuming the marker', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('world\n') });
    collapse(container.querySelector('p')!.firstChild!, 0);
    drive(surface).applyInsertText('#');
    collapse(container.querySelector('p')!.firstChild!, 1);
    drive(surface).applyInsertText(' ');

    const b = blocks(surface)[0]!;
    expect(b.type).toBe('heading');
    expect(b.type === 'heading' && b.level).toBe(1);
    expect(b.type === 'heading' && b.inline[0]?.kind === 'text' && b.inline[0].text).toBe('world');
  });

  it('"### " converts to H3', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('world\n') });
    for (let i = 0; i < 3; i++) {
      collapse(container.querySelector('p')!.firstChild!, i);
      drive(surface).applyInsertText('#');
    }
    collapse(container.querySelector('p')!.firstChild!, 3);
    drive(surface).applyInsertText(' ');

    const b = blocks(surface)[0]!;
    expect(b.type === 'heading' && b.level).toBe(3);
  });
});

describe('marker rules in containers (SKR-188)', () => {
  it('"- " inside a blockquote makes a bullet list within the quote', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('> hello\n') });
    const p = container.querySelector('blockquote p')!;
    collapse(p.firstChild!, 0);
    drive(surface).applyInsertText('-');
    collapse(container.querySelector('blockquote p')!.firstChild!, 1);
    drive(surface).applyInsertText(' ');

    const quote = blocks(surface)[0]!;
    expect(quote.type).toBe('blockquote');
    if (quote.type !== 'blockquote') throw new Error('expected blockquote');
    expect(quote.children[0]!.type).toBe('bullet_list');
  });

  it('does not fire inside an existing list item (keeps the literal marker)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('- item\n') });
    const p = container.querySelector('li p') ?? container.querySelector('li')!;
    collapse(p.firstChild!, 0);
    drive(surface).applyInsertText('-');
    const p2 = container.querySelector('li p') ?? container.querySelector('li')!;
    collapse(p2.firstChild!, 1);
    drive(surface).applyInsertText(' ');

    const list = blocks(surface)[0]!;
    expect(list.type).toBe('bullet_list'); // still one list, not converted/unwrapped
    if (list.type !== 'bullet_list') throw new Error('expected list');
    const itemPara = list.items[0]!.children[0]!;
    expect(itemPara.type === 'paragraph' && itemPara.inline[0]?.kind === 'text' && itemPara.inline[0].text).toBe('- item');
  });
});
