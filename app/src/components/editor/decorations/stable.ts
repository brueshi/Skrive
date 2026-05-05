// Stabilize emphasis styling on the line the cursor is on.
//
// The problem: CommonMark says a closing `**` can't be preceded by
// whitespace. So the instant a user types a space inside a bold span —
// `**bold **` — the parser drops the StrongEmphasis node and the editor's
// highlight tags stop applying `font-weight: bold`. A keystroke later the
// user adds another character and the span becomes valid again. The user
// perceives this as the text flashing between bold and normal.
//
// The fix is a `StateField` that *remembers* mark decorations it has seen
// the parser report as valid, anchored to the cursor line. When the parser
// briefly loses a span, the field keeps the last-known-good class applied
// at the range we recorded. Positions are mapped forward through every
// transaction so the marks stay in the right place across edits.
//
// Known limitation: a residual flicker can still appear during active
// typing. This is inherent to inline previewing. We've chosen to accept
// it rather than debounce correctness or fork the parser.

import { StateField } from '@codemirror/state';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

const STABLE_CLASSES: Record<string, string> = {
  Emphasis: 'cm-md-italic',
  StrongEmphasis: 'cm-md-bold',
  Strikethrough: 'cm-md-strikethrough'
};

const MARKER_NAMES = new Set(['EmphasisMark', 'StrikethroughMark']);

function innerRangeOf(container: SyntaxNode): { from: number; to: number } | null {
  let first = container.firstChild;
  let last = container.lastChild;
  while (first && !MARKER_NAMES.has(first.name)) first = first.nextSibling;
  while (last && !MARKER_NAMES.has(last.name)) last = last.prevSibling;
  if (!first || !last || first === last) return null;
  return { from: first.to, to: last.from };
}

function cursorLineRange(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1) return null;
  const main = sel.main;
  if (!main.empty) return null;
  const line = state.doc.lineAt(main.head);
  return { from: line.from, to: line.to };
}

function collectParserValid(
  state: EditorState,
  lineFrom: number,
  lineTo: number
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    from: lineFrom,
    to: lineTo,
    enter(node) {
      const className = STABLE_CLASSES[node.name];
      if (!className) return;
      const inner = innerRangeOf(node.node);
      if (!inner || inner.to <= inner.from) return;
      out.push(Decoration.mark({ class: className }).range(inner.from, inner.to));
    }
  });
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}

export const stableEmphasisField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },

  update(value, tr) {
    value = value.map(tr.changes);

    const state = tr.state;
    const bounds = cursorLineRange(state);

    if (!bounds) return Decoration.none;

    value = value.update({
      filter: (from, to) => from >= bounds.from && to <= bounds.to
    });

    const current = collectParserValid(state, bounds.from, bounds.to);
    if (current.length === 0) {
      return value;
    }

    value = value.update({
      filter: (from, to) => {
        for (const { from: cf, to: ct } of current) {
          if (cf < to && ct > from) return false;
        }
        return true;
      }
    });

    value = value.update({ add: current, sort: true });
    return value;
  },

  provide: (f) => EditorView.decorations.from(f)
});
