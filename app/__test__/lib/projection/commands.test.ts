// The Rich command layer, exercised through real ProseMirror transactions (no
// DOM) and the serializer — the same discipline as editing.test.ts. Two things
// matter: a committed affordance serializes to canonical Markdown, and an
// affordance applied-then-reverted restores the original bytes (the Stage 3
// gate's "abandoned insert leaves the buffer byte-identical").

import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { schema } from '../../../src/lib/projection/schema';
import { parseDoc } from '../../../src/lib/projection/parse';
import { serializeDoc } from '../../../src/lib/projection/serialize';
import { dirtyPlugin } from '../../../src/lib/projection/dirty';
import {
  setHeading,
  setParagraph,
  toggleBulletList,
  toggleOrderedList,
  toggleBlockquote,
  insertDivider,
  insertTable,
  toggleStrong,
  setLink,
  readSelectionSummary
} from '../../../src/lib/projection/commands';

function stateFrom(md: string): EditorState {
  return EditorState.create({ doc: parseDoc(md), plugins: [dirtyPlugin] });
}

/** Place a collapsed cursor inside the first text node containing `substr`. */
function cursorIn(state: EditorState, substr: string): EditorState {
  let pos = -1;
  state.doc.descendants((node, p) => {
    if (pos === -1 && node.isText && node.text?.includes(substr)) pos = p + 1;
  });
  if (pos === -1) throw new Error(`text not found: ${substr}`);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

/** Select exactly the first occurrence of `substr`. */
function selectText(state: EditorState, substr: string): EditorState {
  let from = -1;
  let to = -1;
  state.doc.descendants((node, p) => {
    if (from === -1 && node.isText && node.text) {
      const i = node.text.indexOf(substr);
      if (i >= 0) {
        from = p + i;
        to = from + substr.length;
      }
    }
  });
  if (from === -1) throw new Error(`text not found: ${substr}`);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

function run(state: EditorState, cmd: Command): EditorState {
  let out = state;
  cmd(state, (tr) => {
    out = state.apply(tr);
  });
  return out;
}

describe('Rich command layer — block types', () => {
  it('setHeading turns a paragraph into a canonical heading', () => {
    const s = cursorIn(stateFrom('Hello world\n'), 'Hello');
    expect(serializeDoc(run(s, setHeading(2)).doc)).toContain('## Hello world');
  });

  it('heading then back to paragraph restores the original bytes', () => {
    const md = 'Hello world\n';
    const h = run(cursorIn(stateFrom(md), 'Hello'), setHeading(2));
    const back = run(cursorIn(h, 'Hello'), setParagraph);
    expect(serializeDoc(back.doc)).toBe(md);
  });

  it('converting one block leaves the others verbatim', () => {
    const md = 'Heading me\n\n* keep star\n';
    const out = serializeDoc(run(cursorIn(stateFrom(md), 'Heading'), setHeading(1)).doc);
    expect(out).toContain('# Heading me');
    expect(out).toContain('* keep star'); // untouched list keeps its `*` marker
    expect(out).not.toContain('- keep star');
  });
});

describe('Rich command layer — lists and blockquote', () => {
  it('toggleBulletList wraps a paragraph in a bullet list', () => {
    const out = serializeDoc(run(cursorIn(stateFrom('Item text\n'), 'Item'), toggleBulletList).doc);
    expect(out).toContain('- Item text');
  });

  it('toggleOrderedList from inside a bullet list switches the list type', () => {
    const bullet = run(cursorIn(stateFrom('Item text\n'), 'Item'), toggleBulletList);
    const out = serializeDoc(run(cursorIn(bullet, 'Item'), toggleOrderedList).doc);
    expect(out).toContain('1. Item text');
    expect(out).not.toContain('- Item text');
  });

  it('toggleBlockquote wraps a paragraph in a quote', () => {
    const out = serializeDoc(run(cursorIn(stateFrom('Quote me\n'), 'Quote'), toggleBlockquote).doc);
    expect(out).toContain('> Quote me');
  });
});

describe('Rich command layer — inserts', () => {
  it('insertDivider emits a canonical thematic break', () => {
    expect(serializeDoc(run(cursorIn(stateFrom('Para one\n'), 'Para'), insertDivider).doc)).toContain('---');
  });

  it('insertTable emits a GFM table with a delimiter row', () => {
    const out = serializeDoc(run(cursorIn(stateFrom('Para one\n'), 'Para'), insertTable).doc);
    expect(out).toContain('| --- | --- |');
  });
});

describe('Rich command layer — inline marks and links', () => {
  it('toggleStrong wraps the selection in bold', () => {
    const out = serializeDoc(run(selectText(stateFrom('make bold here\n'), 'bold'), toggleStrong).doc);
    expect(out).toContain('make **bold** here');
  });

  it('toggling a mark on then off restores the original bytes', () => {
    const md = 'plain text here\n';
    const on = run(selectText(stateFrom(md), 'text'), toggleStrong);
    const off = run(selectText(on, 'text'), toggleStrong);
    expect(serializeDoc(off.doc)).toBe(md);
  });

  it('setLink wraps the selection in a Markdown link', () => {
    const out = serializeDoc(run(selectText(stateFrom('click here now\n'), 'here'), setLink('https://example.com')).doc);
    expect(out).toContain('[here](https://example.com)');
  });
});

describe('Rich hard breaks (Shift-Enter)', () => {
  it('parses a backslash hard break into a hard_break node', () => {
    const doc = parseDoc('a\\\nb\n');
    let found = false;
    doc.descendants((n) => {
      if (n.type.name === 'hard_break') found = true;
    });
    expect(found).toBe(true);
  });

  it('round-trips an untouched hard break byte-for-byte', () => {
    const md = 'a\\\nb\n';
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it('serializes an inserted hard break as a backslash line break', () => {
    const base = stateFrom('ab\n');
    const cursor = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, 2)) // between a and b
    );
    const br = schema.nodes.hard_break.create();
    const out = serializeDoc(cursor.apply(cursor.tr.replaceSelectionWith(br)).doc);
    expect(out).toContain('a\\\nb');
  });
});

describe('Rich command layer — selection summary', () => {
  it('reads block type and live mark state', () => {
    const base = selectText(stateFrom('hello world\n'), 'hello');
    const before = readSelectionSummary(base);
    expect(before.blockType).toBe('paragraph');
    expect(before.strong).toBe(false);

    const bolded = run(base, toggleStrong);
    expect(readSelectionSummary(selectText(bolded, 'hello')).strong).toBe(true);
  });

  it('reports heading level and link href', () => {
    const heading = run(cursorIn(stateFrom('Title here\n'), 'Title'), setHeading(3));
    expect(readSelectionSummary(cursorIn(heading, 'Title')).headingLevel).toBe(3);

    const linked = run(selectText(stateFrom('see link text\n'), 'link'), setLink('https://example.com'));
    const sum = readSelectionSummary(cursorIn(linked, 'link'));
    expect(sum.link).toBe(true);
    expect(sum.linkHref).toBe('https://example.com');
  });
});
