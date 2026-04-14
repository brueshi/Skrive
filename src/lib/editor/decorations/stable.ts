// Stabilize emphasis styling on the line the cursor is on.
//
// The problem this mitigates (but does not fully eliminate — see note below):
//
//   CommonMark says a closing `**` can't be preceded by whitespace. So the
//   instant a user types a space inside a bold span — `**bold **` — the
//   parser drops the StrongEmphasis node and the editor's highlight tags
//   stop applying `font-weight: bold`. A keystroke later the user adds
//   another character and the span becomes valid again, at which point
//   the bold styling returns. The user perceives this as the text flashing
//   between bold and normal while they type. Same issue applies to italic
//   and strikethrough.
//
// Known limitation: even with this field plus the source-of-truth fix
// (emphasis styling removed from HighlightStyle so there is only one
// pipeline applying `cm-md-bold` / italic / strikethrough), a residual
// flicker can still appear during active typing. This is inherent to
// inline previewing — any system that reflects the parser's view of the
// document has to deal with the parser temporarily disagreeing with the
// user's intent mid-keystroke. We've chosen to accept it rather than
// debounce correctness or fork the parser. Do not chase this further
// without a concrete new idea.
//
// The fix is a `StateField` that *remembers* mark decorations it has seen
// the parser report as valid, anchored to the cursor line. When the parser
// briefly loses a span, the field keeps the last-known-good `cm-md-bold`
// (or italic / strikethrough) class applied at the range we recorded.
// Positions are mapped forward through every transaction so the marks
// stay in the right place across edits.
//
// The field clears itself whenever the cursor leaves the line or the
// selection goes non-empty. That avoids stale marks lingering across
// unrelated edits elsewhere in the document.
//
// Overlap policy: when the parser *does* currently see valid emphasis,
// we trust its view — we drop any stabilized mark that overlaps a parser
// range and replace it with the parser's fresh range. This means a
// parser-valid span on the same line as a parser-lost span coexist
// correctly: the valid one is parser-fresh, the lost one is stabilized.

import { StateField } from "@codemirror/state";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

const STABLE_CLASSES: Record<string, string> = {
  Emphasis: "cm-md-italic",
  StrongEmphasis: "cm-md-bold",
  Strikethrough: "cm-md-strikethrough",
};

const MARKER_NAMES = new Set(["EmphasisMark", "StrikethroughMark"]);

function innerRangeOf(
  container: SyntaxNode,
): { from: number; to: number } | null {
  let first = container.firstChild;
  let last = container.lastChild;
  while (first && !MARKER_NAMES.has(first.name)) first = first.nextSibling;
  while (last && !MARKER_NAMES.has(last.name)) last = last.prevSibling;
  if (!first || !last || first === last) return null;
  return { from: first.to, to: last.from };
}

/**
 * The current cursor line's document range, or `null` if the selection
 * has any non-empty range (we don't stabilize across selection drags).
 */
function cursorLineRange(
  state: EditorState,
): { from: number; to: number } | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1) return null;
  const main = sel.main;
  if (!main.empty) return null;
  const line = state.doc.lineAt(main.head);
  return { from: line.from, to: line.to };
}

/**
 * Walk the tree across the cursor line and return every parser-valid
 * emphasis inner range as a mark decoration carrying the right class.
 */
function collectParserValid(
  state: EditorState,
  lineFrom: number,
  lineTo: number,
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
      out.push(
        Decoration.mark({ class: className }).range(inner.from, inner.to),
      );
    },
  });
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}

export const stableEmphasisField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },

  update(value, tr) {
    // Shift existing marks through any document changes first — this is
    // what keeps stabilized ranges pointing at the same logical text even
    // after the user has typed a character.
    value = value.map(tr.changes);

    const state = tr.state;
    const bounds = cursorLineRange(state);

    // No single caret on a line → nothing to stabilize. Clear.
    if (!bounds) return Decoration.none;

    // Keep only the marks that fit entirely inside the current cursor line.
    // The map above may have pushed a range onto the next line, and the
    // cursor may have moved between updates.
    value = value.update({
      filter: (from, to) => from >= bounds.from && to <= bounds.to,
    });

    // Pull the parser's current view of emphasis on this line.
    const current = collectParserValid(state, bounds.from, bounds.to);
    if (current.length === 0) {
      // Parser sees nothing on the line right now. Hold onto what we had.
      return value;
    }

    // The parser has fresh information for any span it currently sees.
    // Drop stabilized marks that overlap any parser-current range so the
    // parser's view wins when both exist. Stabilized marks that don't
    // overlap anything current are kept — they're the ones parser just
    // lost to whitespace or similar.
    value = value.update({
      filter: (from, to) => {
        for (const { from: cf, to: ct } of current) {
          if (cf < to && ct > from) return false;
        }
        return true;
      },
    });

    // Add the parser-current ranges. Pass `sort: true` because we're
    // mixing them with existing marks whose order may overlap.
    value = value.update({ add: current, sort: true });
    return value;
  },

  provide: (f) => EditorView.decorations.from(f),
});
