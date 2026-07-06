// @vitest-environment jsdom
//
// The slash (insert-menu) session lifecycle (SKR-172 / F69). Two of the three
// bugs this ticket fixes live here in surface.ts: applySlashCommand used to
// convert whatever block the caret currently sat in once the menu had a
// mismatched blockId, instead of refusing (a click into another paragraph,
// then choosing an item, converted the CLICKED block and left the original
// with its `/query` residue); and nothing closed the session on a pure
// selection move (only an edit re-ran refreshSlash), so a fast
// click-then-Enter could race the async selection observer. Both are fixed by
// a single shared "is the caret still a collapsed caret in the slash block"
// predicate, exercised directly here (as block-selection.test.ts does for its
// own selection-observer method) rather than round-tripping through a real
// `selectionchange` event + rAF, which is timing-dependent and not what those
// entry points need pinned.
//
// The other two SKR-172 fixes (the zero-match empty state / disarmed keys, and
// the reopen-highlight reset) live entirely in BlockSlashMenu.tsx and are
// covered by __test__/components/block-slash-menu.test.tsx instead.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../jsdom-range-rect';
import { BlockSurface } from '../../src/lib/blocksurface';
import { generateBlockId, type BlockNode, type Document } from '../../src/lib/blockmodel';
import { inlinePlainText } from '../../src/lib/blocksurface/inline-ops';
import { setCaret } from '../../src/lib/blocksurface/selection';
import type { SlashMenuState } from '../../src/lib/blocksurface';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

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
// empty item paragraph — the shape the container-opener tests below need to
// place an empty leaf without going through the Markdown parser, which drops
// an item with no content).
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
// A single top-level blockquote with one paragraph child.
function blockquoteDoc(text: string): Document {
  const quote: BlockNode = {
    type: 'blockquote',
    id: generateBlockId(),
    durable: false,
    src: null,
    gapBefore: null,
    dirty: false,
    children: [paragraph(text)]
  } as BlockNode;
  return { blocks: [quote], trailingGap: '\n' };
}
// Types one character at a time via the private hot path, mirroring real
// keystrokes — handleSlashAfterInsert only opens a session when the INSERTED
// text is exactly '/', so a single call with a multi-char string would never
// trigger it (barrier-selection.test.ts's typeText helper types whole strings
// at once for that reason: it isn't exercising the slash trigger).
function type(surface: BlockSurface, text: string): void {
  const apply = (surface as unknown as { applyInsertText: (t: string) => void }).applyInsertText.bind(surface);
  for (const ch of text) apply(ch);
}
function backspace(surface: BlockSurface): void {
  (surface as unknown as { applyDeleteBackward: () => void }).applyDeleteBackward();
}
function paragraphEls(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll('p'));
}
function blocksOf(surface: BlockSurface): BlockNode[] {
  return surface.getDocument().blocks;
}
function textOf(block: BlockNode): string {
  return block.type === 'paragraph' || block.type === 'heading' ? inlinePlainText(block.inline) : '';
}
function slashOf(surface: BlockSurface): unknown {
  return (surface as unknown as { slash: unknown }).slash;
}
function closeSlashOnSelectionMove(surface: BlockSurface): void {
  (surface as unknown as { closeSlashOnSelectionMove: () => void }).closeSlashOnSelectionMove();
}

describe('slash session — the normal flow', () => {
  it('opens only when / is the entire block, tracks the query, and applies to the slash block', () => {
    const surface = new BlockSurface({ container, doc: docOf('', 'world') });
    const [firstEl] = paragraphEls(container);
    setCaret(firstEl!, 0);

    // A boxed field, not a bare `let`: reassigning a plain `let` from inside a
    // callback defeats TS's control-flow narrowing on later reads of it.
    const box: { state: SlashMenuState | null } = { state: null };
    surface.onSlashMenu((s) => {
      box.state = s;
    });

    type(surface, '/');
    expect(slashOf(surface)).not.toBeNull();
    expect(box.state?.query).toBe('');

    type(surface, 'h1');
    expect(box.state?.query).toBe('h1');

    surface.applySlashCommand({ kind: 'heading', level: 1 });

    const blocks = blocksOf(surface);
    expect(blocks[0]!.type).toBe('heading');
    expect(textOf(blocks[0]!)).toBe(''); // the /query text is stripped, not left behind
    expect(slashOf(surface)).toBeNull();
    // The untouched second block is proof this is the right-block case, the
    // contrast for the mismatch tests below.
    expect(textOf(blocks[1]!)).toBe('world');
  });
});

describe('applySlashCommand refuses a stale caret (SKR-172 / F69)', () => {
  it('refuses and closes without converting when the caret moved to a different block', () => {
    const surface = new BlockSurface({ container, doc: docOf('', 'world') });
    const [firstEl, secondEl] = paragraphEls(container);
    setCaret(firstEl!, 0);
    type(surface, '/');
    type(surface, 'query');
    expect(slashOf(surface)).not.toBeNull();

    // A click into the other paragraph: the caret moves without an edit, so
    // nothing has re-run refreshSlash yet — the model still thinks the
    // session is open until the observer or this recheck catches it.
    setCaret(secondEl!, 0);

    surface.applySlashCommand({ kind: 'heading', level: 1 });

    const blocks = blocksOf(surface);
    expect(blocks[0]!.type).toBe('paragraph');
    expect(textOf(blocks[0]!)).toBe('/query'); // residue left alone (matches Notion; not this bug)
    expect(blocks[1]!.type).toBe('paragraph'); // NOT converted — this is the bug being closed
    expect(textOf(blocks[1]!)).toBe('world');
    expect(slashOf(surface)).toBeNull(); // refused, and the stale session is closed
  });

  it('refuses when the caret becomes a non-collapsed selection inside the slash block', () => {
    const surface = new BlockSurface({ container, doc: docOf('') });
    const [firstEl] = paragraphEls(container);
    setCaret(firstEl!, 0);
    type(surface, '/');
    type(surface, 'h1');

    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(firstEl!);
    sel.removeAllRanges();
    sel.addRange(range);

    surface.applySlashCommand({ kind: 'heading', level: 1 });

    expect(blocksOf(surface)[0]!.type).toBe('paragraph'); // refused
    expect(slashOf(surface)).toBeNull();
  });

  it('still applies when the caret is genuinely still in the slash block', () => {
    const surface = new BlockSurface({ container, doc: docOf('') });
    const [firstEl] = paragraphEls(container);
    setCaret(firstEl!, 0);
    type(surface, '/');

    surface.applySlashCommand({ kind: 'divider' });

    expect(blocksOf(surface)[0]!.type).toBe('horizontal_rule');
  });
});

describe('the selection-observer close (SKR-172 / F69)', () => {
  it('closes when the caret moves to a different block', () => {
    const surface = new BlockSurface({ container, doc: docOf('', 'world') });
    const [firstEl, secondEl] = paragraphEls(container);
    setCaret(firstEl!, 0);
    type(surface, '/');
    expect(slashOf(surface)).not.toBeNull();

    setCaret(secondEl!, 0);
    closeSlashOnSelectionMove(surface);

    expect(slashOf(surface)).toBeNull();
  });

  it('closes when the selection widens into a range in the same block', () => {
    const surface = new BlockSurface({ container, doc: docOf('') });
    const [firstEl] = paragraphEls(container);
    setCaret(firstEl!, 0);
    type(surface, '/');
    type(surface, 'h1');

    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(firstEl!);
    sel.removeAllRanges();
    sel.addRange(range);

    closeSlashOnSelectionMove(surface);

    expect(slashOf(surface)).toBeNull();
  });

  it('leaves the session open while the caret is still a collapsed caret in the slash block', () => {
    const surface = new BlockSurface({ container, doc: docOf('') });
    const [firstEl] = paragraphEls(container);
    setCaret(firstEl!, 0);
    type(surface, '/');
    type(surface, 'h1');

    // Re-placed collapsed caret still inside the same block (e.g. an arrow key
    // the browser resolved natively) must NOT close the session.
    setCaret(firstEl!, 3);
    closeSlashOnSelectionMove(surface);

    expect(slashOf(surface)).not.toBeNull();
  });

  it('closes when focus leaves the surface entirely', () => {
    const surface = new BlockSurface({ container, doc: docOf('') });
    const [firstEl] = paragraphEls(container);
    setCaret(firstEl!, 0);
    type(surface, '/');

    const outside = document.createElement('div');
    outside.textContent = 'x';
    document.body.appendChild(outside);
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(outside.firstChild!, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    closeSlashOnSelectionMove(surface);

    expect(slashOf(surface)).toBeNull();
    outside.remove();
  });
});

describe('regression: refreshSlash keeps closing on the existing edit-driven paths', () => {
  it('closes when the query grows a space', () => {
    const surface = new BlockSurface({ container, doc: docOf('') });
    const [firstEl] = paragraphEls(container);
    setCaret(firstEl!, 0);
    type(surface, '/foo');
    expect(slashOf(surface)).not.toBeNull();

    type(surface, ' ');
    expect(slashOf(surface)).toBeNull();
  });

  it('closes when the run is deleted back past the leading slash', () => {
    const surface = new BlockSurface({ container, doc: docOf('') });
    const [firstEl] = paragraphEls(container);
    setCaret(firstEl!, 0);
    type(surface, '/');
    expect(slashOf(surface)).not.toBeNull();

    backspace(surface); // deletes the '/' itself
    expect(slashOf(surface)).toBeNull();
  });
});

// The opener was top-level-only (currentInlineBlock resolves through the
// registry, which only holds top-level elements): `/` typed into an empty list
// item or blockquote child never started a session. SKR-169 already made the
// SINK (applySlashCommand -> setBlockType) container-aware; this section pins
// the OPENER and the session plumbing (leaf-aware caret-intact checks, query
// stripping via updateBlockById, and the rect anchoring to the leaf) that let a
// session opened inside a container behave exactly like one at top level
// (SKR-218).
describe('slash session inside containers (SKR-218)', () => {
  it('opens on an empty list item, tracks the query, and Heading lifts the item out with the query stripped', () => {
    const surface = new BlockSurface({ container, doc: bulletListDoc('alpha', '') });
    const items = container.querySelectorAll<HTMLElement>('li p');
    setCaret(items[1]!, 0);

    const box: { state: SlashMenuState | null } = { state: null };
    surface.onSlashMenu((s) => {
      box.state = s;
    });

    type(surface, '/');
    expect(slashOf(surface)).not.toBeNull();
    expect(box.state?.query).toBe('');

    type(surface, 'h1');
    expect(box.state?.query).toBe('h1');

    surface.applySlashCommand({ kind: 'heading', level: 1 });

    const blocks = blocksOf(surface);
    // The item lifts out of the list (SKR-169 semantics): the list survives
    // with just the first item, and the lifted item becomes a top-level heading.
    expect(blocks.map((b) => b.type)).toEqual(['bullet_list', 'heading']);
    expect(textOf(blocks[1]!)).toBe(''); // the /query text was stripped, not left behind
    expect(slashOf(surface)).toBeNull();
  });

  it('opens on an empty blockquote child and converts it in place, staying inside the quote', () => {
    const surface = new BlockSurface({ container, doc: blockquoteDoc('') });
    const child = container.querySelector<HTMLElement>('blockquote p')!;
    setCaret(child, 0);

    type(surface, '/');
    expect(slashOf(surface)).not.toBeNull();
    type(surface, 'h2');

    surface.applySlashCommand({ kind: 'heading', level: 2 });

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['blockquote']);
    const quoteChild = (blocks[0] as unknown as { children: BlockNode[] }).children[0]!;
    expect(quoteChild.type).toBe('heading');
    expect(textOf(quoteChild)).toBe(''); // stripped, not carried into the heading
    expect(slashOf(surface)).toBeNull();
  });

  it('inserts a divider after the enclosing list, leaving the item intact and query-stripped', () => {
    const surface = new BlockSurface({ container, doc: bulletListDoc('alpha', '') });
    const items = container.querySelectorAll<HTMLElement>('li p');
    setCaret(items[1]!, 0);

    type(surface, '/');
    type(surface, 'div');
    surface.applySlashCommand({ kind: 'divider' });

    const blocks = blocksOf(surface);
    // No next block for the caret to land in, so a fresh paragraph is seeded
    // after the divider (SKR-170's "never a trap" rule — same as the top-level
    // insert-after-content path).
    expect(blocks.map((b) => b.type)).toEqual(['bullet_list', 'horizontal_rule', 'paragraph']);
    const list = blocks[0] as unknown as { items: Array<{ children: BlockNode[] }> };
    expect(list.items).toHaveLength(2); // the item stays IN the list, not lifted
    expect(textOf(list.items[0]!.children[0]!)).toBe('alpha');
    expect(textOf(list.items[1]!.children[0]!)).toBe(''); // query stripped
    expect(slashOf(surface)).toBeNull();
  });

  it('does not open when / is typed mid-text in a list item (parity with the top-level rule)', () => {
    const surface = new BlockSurface({ container, doc: bulletListDoc('abc') });
    const [item] = container.querySelectorAll<HTMLElement>('li p');
    setCaret(item!, 2); // caret between 'ab' and 'c'

    type(surface, '/');

    expect(slashOf(surface)).toBeNull();
    const list = blocksOf(surface)[0] as unknown as { items: Array<{ children: BlockNode[] }> };
    expect(textOf(list.items[0]!.children[0]!)).toBe('ab/c'); // the / just typed in as text
  });

  it('closes when the caret moves to a different leaf in the same container', () => {
    const surface = new BlockSurface({ container, doc: bulletListDoc('alpha', '') });
    const items = container.querySelectorAll<HTMLElement>('li p');
    setCaret(items[1]!, 0);
    type(surface, '/');
    type(surface, 'query');
    expect(slashOf(surface)).not.toBeNull();

    setCaret(items[0]!, 0);
    closeSlashOnSelectionMove(surface);

    expect(slashOf(surface)).toBeNull();
  });

  it('refuses to apply when the caret moved to a different leaf before the command runs', () => {
    const surface = new BlockSurface({ container, doc: bulletListDoc('alpha', '') });
    const items = container.querySelectorAll<HTMLElement>('li p');
    setCaret(items[1]!, 0);
    type(surface, '/');
    type(surface, 'query');
    expect(slashOf(surface)).not.toBeNull();

    // A click into the other item: the caret moves without an edit, so nothing
    // has re-run refreshSlash yet, mirroring the top-level mismatch case.
    setCaret(items[0]!, 0);

    surface.applySlashCommand({ kind: 'heading', level: 1 });

    const blocks = blocksOf(surface);
    expect(blocks.map((b) => b.type)).toEqual(['bullet_list']); // NOT converted
    const list = blocks[0] as unknown as { items: Array<{ children: BlockNode[] }> };
    expect(textOf(list.items[0]!.children[0]!)).toBe('alpha');
    expect(textOf(list.items[1]!.children[0]!)).toBe('/query'); // residue left alone
    expect(slashOf(surface)).toBeNull(); // refused, and the stale session is closed
  });
});
