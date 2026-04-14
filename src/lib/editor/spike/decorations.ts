// Phase 2.2 decorations spike — THROWAWAY.
//
// This file exists to answer three yes/no questions before we commit to
// building the full inline preview system:
//
//   Q1. Can a CM6 widget decoration render an inline image inside a markdown
//       line without fighting the editing surface?
//   Q2. Can a replace decoration collapse `**bold**` markers on lines where
//       the cursor is absent, while keeping the bold text visible?
//   Q3. Does the fold cleanly restore when the cursor returns to that line,
//       with no flicker and a sensible cursor placement?
//
// Code here is not expected to ship. It uses the simplest possible regex
// scanner over visible ranges rather than the markdown language tree, which
// means nesting, inline code spans containing stars, and escape sequences
// will all behave slightly wrong. The production implementation in Phase 2.2
// proper will walk the syntax tree instead — but the failure modes of a
// regex scanner are irrelevant to the three questions above.
//
// Mounted on a hardcoded sample in src/routes/spike/decorations/+page.svelte.
// The real Editor.svelte is untouched.

import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";

// ============================================================================
// Q1 — Inline image widget
// ============================================================================

/**
 * A single `<img>` rendered in place of the `![alt](src)` syntax. The whole
 * match is replaced, so the markup characters disappear while the cursor is
 * elsewhere; bringing the cursor back to the line reveals them again via the
 * same cursor-awareness pattern used for emphasis below.
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-spike-image";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    // Inline sizing cap so a runaway remote image doesn't blow up the
    // viewport while we're evaluating the spike. The production version
    // will use proper CSS from decorations.css.
    img.style.maxHeight = "4em";
    img.style.maxWidth = "12em";
    img.style.verticalAlign = "middle";
    img.style.borderRadius = "3px";
    wrap.appendChild(img);
    return wrap;
  }

  // Important: widgets that contain interactive content (like loading images)
  // should return true from `ignoreEvent` for events we don't care about.
  // An image click should not steal focus from the editor during the spike.
  ignoreEvent(): boolean {
    return false;
  }
}

const IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

function buildImageDecorations(view: EditorView): DecorationSet {
  const builder: Range<Decoration>[] = [];
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head)
    .number;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    IMAGE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_RE.exec(text)) !== null) {
      const start = from + match.index;
      const end = start + match[0].length;

      // Respect the same cursor rule as emphasis: reveal the raw syntax on
      // the line the user is editing so they can actually change the URL
      // or alt text. This is the whole reason this scheme is worth doing —
      // the editing affordance stays intact.
      const lineNumber = view.state.doc.lineAt(start).number;
      if (lineNumber === cursorLine) continue;

      const [, alt, src] = match;
      builder.push(
        Decoration.replace({
          widget: new ImageWidget(src, alt),
          inclusive: false,
        }).range(start, end),
      );
    }
  }
  return Decoration.set(builder, true);
}

export const imagesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildImageDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet
      ) {
        this.decorations = buildImageDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// ============================================================================
// Q2 + Q3 — Emphasis fold on cursor-leave, restore on cursor-return
// ============================================================================

// Simple non-greedy match for **bold** on a single line. The spike does not
// handle nesting, escaped asterisks, or code spans that happen to contain
// stars. The production implementation will use the markdown syntax tree.
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;

function buildEmphasisDecorations(view: EditorView): DecorationSet {
  const builder: Range<Decoration>[] = [];
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head)
    .number;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    BOLD_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BOLD_RE.exec(text)) !== null) {
      const matchStart = from + match.index;
      const matchEnd = matchStart + match[0].length;

      const lineNumber = view.state.doc.lineAt(matchStart).number;
      if (lineNumber === cursorLine) continue;

      // Three stacked decorations per match:
      //   1. Replace the leading `**` with nothing.
      //   2. Mark the inner text with a bold class.
      //   3. Replace the trailing `**` with nothing.
      //
      // CM6 needs ranges sorted by `from` at the same priority, which
      // they naturally are here because we push them in document order.
      builder.push(
        Decoration.replace({}).range(matchStart, matchStart + 2),
      );
      builder.push(
        Decoration.mark({ class: "cm-spike-bold" }).range(
          matchStart + 2,
          matchEnd - 2,
        ),
      );
      builder.push(
        Decoration.replace({}).range(matchEnd - 2, matchEnd),
      );
    }
  }
  return Decoration.set(builder, true);
}

export const emphasisPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildEmphasisDecorations(view);
    }

    update(update: ViewUpdate) {
      // selectionSet is the critical trigger for Q3 — when the cursor moves
      // onto or off a line containing emphasis, we need to rebuild so the
      // markers reappear or hide accordingly.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet
      ) {
        this.decorations = buildEmphasisDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// ============================================================================
// Combined extension factory
// ============================================================================

/**
 * All spike extensions in a single factory for the mount page. Returning an
 * array keeps the call site simple: one spread into `extensions`.
 */
export function spikeDecorations() {
  return [imagesPlugin, emphasisPlugin];
}
