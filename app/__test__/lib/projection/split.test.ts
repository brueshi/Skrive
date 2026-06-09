// Split-fidelity: pressing Enter must never cost the writer a paragraph break.
//
// ProseMirror's split machinery copies the split node's attrs onto the second
// half — including the projection's captured `src` and `gapBefore`. Splitting
// the FIRST block (gapBefore '') used to produce a second half whose seam
// serialized to '', silently gluing the two paragraphs back together on disk.
// The dirtyPlugin now owns the invariant that a batch-manufactured block can
// never carry captured attrs; these tests drive REAL EditorState transactions
// through the exact Enter wiring RichEditor uses (splitListItem, then the
// baseKeymap Enter chain) and assert the serialized file matches what the
// editor shows — block for block, separator included, siblings byte-identical.

import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { baseKeymap, chainCommands } from 'prosemirror-commands';
import { splitListItem } from 'prosemirror-schema-list';
import { history, undo } from 'prosemirror-history';
import { schema } from '../../../src/lib/projection/schema';
import { parseDoc } from '../../../src/lib/projection/parse';
import { serializeDoc } from '../../../src/lib/projection/serialize';
import { dirtyPlugin } from '../../../src/lib/projection/dirty';
import { insertHardBreak } from '../../../src/lib/projection/commands';

// The same Enter wiring as RichEditor's keymaps: list-item split first, then
// the stock baseKeymap chain (newlineInCode / createParagraphNear /
// liftEmptyBlock / splitBlock).
const pressEnter: Command = chainCommands(
  splitListItem(schema.nodes.list_item),
  baseKeymap['Enter'] as Command
);

function stateFrom(md: string): EditorState {
  return EditorState.create({ doc: parseDoc(md), plugins: [history(), dirtyPlugin] });
}

/** Collapsed cursor right after the first occurrence of `substr`. */
function cursorAfter(state: EditorState, substr: string): EditorState {
  let pos = -1;
  state.doc.descendants((node, p) => {
    if (pos === -1 && node.isText && node.text) {
      const i = node.text.indexOf(substr);
      if (i >= 0) pos = p + i + substr.length;
    }
  });
  if (pos === -1) throw new Error(`text not found: ${substr}`);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

/** Collapsed cursor right before the first occurrence of `substr`. */
function cursorBefore(state: EditorState, substr: string): EditorState {
  let pos = -1;
  state.doc.descendants((node, p) => {
    if (pos === -1 && node.isText && node.text) {
      const i = node.text.indexOf(substr);
      if (i >= 0) pos = p + i;
    }
  });
  if (pos === -1) throw new Error(`text not found: ${substr}`);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function run(state: EditorState, cmd: Command): EditorState {
  let out = state;
  const handled = cmd(state, (tr) => {
    out = state.apply(tr);
  });
  if (!handled) throw new Error('command returned false');
  return out;
}

function type(state: EditorState, text: string): EditorState {
  return state.apply(state.tr.insertText(text));
}

/** Top-level block shape of a doc: type name + text, for editor<->file compares. */
function blockShape(doc: PMNode): Array<{ type: string; text: string }> {
  const out: Array<{ type: string; text: string }> = [];
  doc.forEach((b) => out.push({ type: b.type.name, text: b.textContent }));
  return out;
}

function countNodes(doc: PMNode, typeName: string): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === typeName) n++;
  });
  return n;
}

describe('Enter splits — paragraph break fidelity', () => {
  const md = 'alpha beta\n\nsecond para\n';

  it('mid-FIRST-paragraph (gapBefore "") — the probe case: separator survives', () => {
    // Was: 'alphatyped beta\n\nsecond para\n' — the break silently gone.
    const out = serializeDoc(type(run(cursorAfter(stateFrom(md), 'alpha'), pressEnter), 'typed').doc);
    expect(out).toBe('alpha\n\ntyped beta\n\nsecond para\n');
  });

  it('start of the FIRST paragraph — content keeps its own paragraph on reparse', () => {
    const next = run(cursorBefore(stateFrom(md), 'alpha'), pressEnter);
    // Editor shows [empty para, 'alpha beta', 'second para']. An empty
    // paragraph has no Markdown form, so the file must round-trip the two
    // non-empty paragraphs — crucially NOT merged.
    const out = serializeDoc(next.doc);
    expect(blockShape(parseDoc(out))).toEqual([
      { type: 'paragraph', text: 'alpha beta' },
      { type: 'paragraph', text: 'second para' }
    ]);
  });

  it('end of the FIRST paragraph — new block lands between, siblings byte-identical', () => {
    const out = serializeDoc(type(run(cursorAfter(stateFrom(md), 'beta'), pressEnter), 'typed').doc);
    expect(out).toBe('alpha beta\n\ntyped\n\nsecond para\n');
  });

  it('mid-MIDDLE-paragraph — both seams around the split survive', () => {
    const src = 'one\n\ntwo three\n\nfour\n';
    const out = serializeDoc(type(run(cursorAfter(stateFrom(src), 'two'), pressEnter), 'X').doc);
    expect(out).toBe('one\n\ntwo\n\nX three\n\nfour\n');
  });

  it('mid-LAST-paragraph — trailing gap intact', () => {
    const src = 'first\n\nlast one\n';
    const out = serializeDoc(type(run(cursorAfter(stateFrom(src), 'last'), pressEnter), 'Z').doc);
    expect(out).toBe('first\n\nlast\n\nZ one\n');
  });

  it('mid-heading — file shows the same two headings the editor does', () => {
    const next = run(cursorAfter(stateFrom('## AlphaBeta\n\nbody\n'), 'Alpha'), pressEnter);
    // PM splits a heading into heading + heading (same level attrs carry).
    expect(blockShape(next.doc)).toEqual([
      { type: 'heading', text: 'Alpha' },
      { type: 'heading', text: 'Beta' },
      { type: 'paragraph', text: 'body' }
    ]);
    expect(serializeDoc(next.doc)).toBe('## Alpha\n\n## Beta\n\nbody\n');
  });

  it('inside a list item (splitListItem path) — one list, three items, marker kept', () => {
    const next = run(cursorAfter(stateFrom('- onetwo\n- three\n'), 'one'), pressEnter);
    expect(next.doc.childCount).toBe(1); // still a single top-level list block
    expect(serializeDoc(next.doc)).toBe('- one\n- two\n- three\n');
  });
});

describe('Enter splits — the attr mechanism, not just the bytes', () => {
  it('the post-split half carries src: null / gapBefore: null; the first half keeps its capture', () => {
    const next = run(cursorAfter(stateFrom('alpha beta\n\nsecond para\n'), 'alpha'), pressEnter);
    const first = next.doc.child(0);
    const second = next.doc.child(1);
    expect(first.attrs.src).toBe('alpha beta'); // legitimate capture untouched
    expect(first.attrs.gapBefore).toBe('');
    expect(second.attrs.src).toBeNull();
    expect(second.attrs.gapBefore).toBeNull();
  });

  it('a moved block (edit above it) keeps its captured attrs — no false positives', () => {
    const state = stateFrom('alpha beta\n\nsecond para\n');
    // Delete the first block entirely; 'second para' shifts but is still the
    // same parsed block, so its capture must survive.
    const next = state.apply(state.tr.delete(0, state.doc.child(0).nodeSize));
    const survivor = next.doc.child(0);
    expect(survivor.attrs.src).toBe('second para');
    expect(survivor.attrs.gapBefore).toBe('\n\n');
  });

  it('a duplicated captured block (paste-shaped insert) is reset, not trusted', () => {
    const state = stateFrom('alpha beta\n\nsecond para\n');
    // Re-insert a copy of the first block at the end — the same attr-cloning
    // shape a block paste produces. Its gapBefore '' would otherwise glue it
    // to the block above.
    const copy = state.doc.child(0);
    const next = state.apply(state.tr.insert(state.doc.content.size, copy));
    const pasted = next.doc.child(2);
    expect(pasted.attrs.src).toBeNull();
    expect(pasted.attrs.gapBefore).toBeNull();
    expect(serializeDoc(next.doc)).toBe('alpha beta\n\nsecond para\n\nalpha beta\n');
  });

  it('undo after a split restores the doc AND the original bytes', () => {
    const md = 'alpha beta\n\nsecond para\n';
    const split = run(cursorAfter(stateFrom(md), 'alpha'), pressEnter);
    expect(split.doc.childCount).toBe(3);
    const undone = run(split, undo);
    expect(undone.doc.childCount).toBe(2);
    expect(undone.doc.child(0).attrs.src).toBe('alpha beta'); // capture restored, not re-derived
    expect(serializeDoc(undone.doc)).toBe(md);
  });
});

describe('Shift-Enter (insertHardBreak) — headings stay single-line', () => {
  it('in a heading: no hard_break node; behaves like Enter instead', () => {
    const next = run(cursorAfter(stateFrom('## AlphaBeta\n\nbody\n'), 'Alpha'), insertHardBreak);
    expect(countNodes(next.doc, 'hard_break')).toBe(0);
    const out = serializeDoc(next.doc);
    expect(out).not.toContain('\\\n'); // no backslash break smuggled into a heading
    expect(out).toBe('## Alpha\n\n## Beta\n\nbody\n');
  });

  it('in a paragraph: still inserts a hard break (regression guard)', () => {
    const next = run(cursorAfter(stateFrom('alpha beta\n'), 'alpha'), insertHardBreak);
    expect(countNodes(next.doc, 'hard_break')).toBe(1);
    // The space before "beta" sits at a line start after the break, where a
    // literal space would be stripped on re-parse — the serializer entity-encodes
    // it so the doc the editor shows is the doc the file means.
    expect(serializeDoc(next.doc)).toBe('alpha\\\n&#x20;beta\n');
  });
});
