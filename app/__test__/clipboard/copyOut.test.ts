// Copy-out logic: selection -> Markdown -> dual-write payload. The DOM event
// wiring (components/editor/clipboard.ts) is deliberately thin and tested by
// hand; everything with behaviour worth pinning lives in these pure functions.

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { buildClipboardPayload, selectionMarkdown } from '../../src/lib/clipboard/copyOut';

function stateWith(doc: string, selection: EditorSelection) {
  return EditorState.create({
    doc,
    selection,
    extensions: EditorState.allowMultipleSelections.of(true)
  });
}

describe('selectionMarkdown', () => {
  it('returns null for an empty (cursor-only) selection', () => {
    const state = stateWith('hello world', EditorSelection.single(3));
    expect(selectionMarkdown(state)).toBeNull();
  });

  it('returns the sliced source for a single range', () => {
    const state = stateWith('hello world', EditorSelection.single(0, 5));
    expect(selectionMarkdown(state)).toBe('hello');
  });

  it('joins multiple ranges with newlines in document order', () => {
    const state = stateWith(
      'alpha beta gamma',
      EditorSelection.create([
        EditorSelection.range(0, 5), // alpha
        EditorSelection.range(11, 16) // gamma
      ])
    );
    expect(selectionMarkdown(state)).toBe('alpha\ngamma');
  });

  it('ignores empty ranges mixed in with a real one', () => {
    const state = stateWith(
      'alpha beta',
      EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.cursor(10)])
    );
    expect(selectionMarkdown(state)).toBe('alpha');
  });
});

describe('buildClipboardPayload', () => {
  it('puts the raw Markdown on the plain-text representation verbatim', () => {
    const md = '# Title\n\nSome **bold** text.';
    expect(buildClipboardPayload(md).text).toBe(md);
  });

  it('renders the Markdown to HTML for the rich representation', () => {
    const { html } = buildClipboardPayload('# Title\n\nSome **bold** text.');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
  });
});
