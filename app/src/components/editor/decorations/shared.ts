// Shared infrastructure for all inline-preview decorations.
//
// Every decoration in this directory follows the same pattern:
//
//   1. A `NodeHandler` function that knows how to handle a single Lezer
//      node type from the markdown grammar (Emphasis, Link, Image, ...).
//   2. A handler map registered with `createInlinePlugin`, which walks the
//      syntax tree across visible ranges on every relevant editor update
//      and dispatches to the right handler for each node it sees.
//
// The key correctness point is *cursor awareness*: on the line where the
// user is editing we reveal the raw markup so they can actually change it,
// everywhere else we hide the syntax. Handlers get this as a precomputed
// helper (`ctx.isOnCursorLine`) so they don't each reimplement it.

import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Range, Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import type { SyntaxNodeRef, Tree } from '@lezer/common';
import type { MarkerMode } from '@skrive/shared';

// The active marker treatment for the surface, held in editor state so the
// decoration plugin can rebuild when it changes. Editor.tsx dispatches
// `setMarkerMode` from the preferences store (initial value + live changes).
export const setMarkerMode = StateEffect.define<MarkerMode>();

export const markerModeField = StateField.define<MarkerMode>({
  create: () => 'recessed',
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkerMode)) return e.value;
    return value;
  }
});

/**
 * Context passed to every handler. Handlers push decorations into the
 * shared `decorations` array and use `isOnCursorLine` to decide whether
 * to hide syntax or leave it revealed.
 */
export type DecorationContext = {
  view: EditorView;
  decorations: Range<Decoration>[];
  /** The active marker treatment. Handlers read this to decide whether to
   *  show markers verbatim ('raw'), dim them ('recessed'), or hide them off
   *  the cursor line ('concealed'). */
  mode: MarkerMode;
  /**
   * True if any line between `from` and `to` (inclusive) contains a
   * cursor or selection range. Used to exclude the current editing
   * context from the fold so the user can still see what they're typing.
   */
  isOnCursorLine(from: number, to: number): boolean;
};

/**
 * Decorate a syntax-marker range (`**`, `#`, `](url)`, backticks, ...) for
 * the active mode. Callers must already have returned early for 'raw' and,
 * where cursor-aware reveal applies, for the on-cursor-line case — so this
 * only handles the two decorating modes:
 *   - 'recessed' → a muted `cm-md-marker` mark (marker stays, receded).
 *   - 'concealed' → a replace that hides the marker entirely.
 */
export function pushMarker(
  ctx: DecorationContext,
  from: number,
  to: number
): void {
  if (from >= to) return;
  if (ctx.mode === 'recessed') {
    ctx.decorations.push(
      Decoration.mark({ class: 'cm-md-marker' }).range(from, to)
    );
  } else {
    ctx.decorations.push(Decoration.replace({}).range(from, to));
  }
}

/**
 * Return `false` from a handler to tell the tree walker to skip this
 * node's subtree. Useful when a container handler (e.g. `Emphasis`) has
 * already produced decorations for its children and doesn't want those
 * children revisited by other handlers.
 */
export type NodeHandler = (
  node: SyntaxNodeRef,
  ctx: DecorationContext
) => boolean | void;

export type HandlerMap = Record<string, NodeHandler>;

function computeCursorLines(
  doc: Text,
  ranges: readonly { from: number; to: number }[]
): Set<number> {
  const lines = new Set<number>();
  for (const range of ranges) {
    const fromLine = doc.lineAt(range.from).number;
    const toLine = doc.lineAt(range.to).number;
    for (let n = fromLine; n <= toLine; n++) lines.add(n);
  }
  return lines;
}

/**
 * Canonical key for the set of lines the selection touches — sorted line
 * numbers joined with commas, so two selections that cover the same lines
 * produce the same key regardless of range order or how many ranges
 * happen to sit on each line.
 *
 * Why this is the right cache key: every handler registered through
 * `createInlinePlugin` consumes the selection *exclusively* through
 * `ctx.isOnCursorLine` — pure line membership, never exact offsets. So a
 * cursor moving within a line (or a selection growing within one line)
 * cannot change any handler's output, and the plugin can skip the
 * viewport-wide tree walk for those updates. If a future handler ever
 * needs exact selection offsets, this key stops being sufficient and the
 * skip logic must be revisited.
 */
export function cursorLineKey(
  doc: Text,
  ranges: readonly { from: number; to: number }[]
): string {
  return [...computeCursorLines(doc, ranges)].sort((a, b) => a - b).join(',');
}

/**
 * Everything that can invalidate the cached decoration set between two
 * builds. Kept as a plain data bag so the decision itself is a pure,
 * unit-testable function rather than logic buried in the ViewPlugin.
 */
export type RebuildSignals = {
  /** The document changed — positions and content are different. */
  docChanged: boolean;
  /** The visible ranges changed — different parts of the tree are walked. */
  viewportChanged: boolean;
  /** The syntax tree advanced (incremental background parsing) — node
   *  structure may differ even though the document text did not change. */
  treeChanged: boolean;
  /** The marker treatment (raw / recessed / concealed) changed. */
  modeChanged: boolean;
  /** Any extra handler config input (e.g. the image resolver) changed. */
  configChanged: boolean;
  /** `cursorLineKey` at the last build vs. now. */
  previousCursorLineKey: string;
  cursorLineKey: string;
};

/**
 * Decide whether a rebuild can be skipped. Safe to skip only when *every*
 * input the handlers consume is unchanged: document, viewport, parse
 * tree, marker mode, handler config, and the cursor-line set. Correctness
 * over cleverness — anything that could alter a handler's output forces
 * the rebuild.
 */
export function shouldSkipRebuild(signals: RebuildSignals): boolean {
  if (
    signals.docChanged ||
    signals.viewportChanged ||
    signals.treeChanged ||
    signals.modeChanged ||
    signals.configChanged
  ) {
    return false;
  }
  return signals.cursorLineKey === signals.previousCursorLineKey;
}

/**
 * Walk the syntax tree across the view's visible ranges and build a
 * `DecorationSet` by dispatching each encountered node to its handler.
 * Called on every relevant `ViewUpdate` — the work is proportional to
 * what's on screen, not the full document size.
 */
export function buildDecorations(
  view: EditorView,
  handlers: HandlerMap
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const cursorLines = computeCursorLines(doc, view.state.selection.ranges);

  const ctx: DecorationContext = {
    view,
    decorations,
    mode: view.state.field(markerModeField, false) ?? 'recessed',
    isOnCursorLine(from, to) {
      const startLine = doc.lineAt(from).number;
      const endLine = doc.lineAt(to).number;
      for (let n = startLine; n <= endLine; n++) {
        if (cursorLines.has(n)) return true;
      }
      return false;
    }
  };

  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const handler = handlers[node.name];
        if (!handler) return;
        const result = handler(node, ctx);
        if (result === false) return false;
      }
    });
  }

  return Decoration.set(decorations, true);
}

/**
 * Read the extra handler config inputs (if any) from two states and
 * report whether any of them differ. Inputs are compared by identity —
 * the values live in StateFields, so a dispatched effect replaces the
 * reference and identity comparison is exact.
 */
function configInputsChanged(
  update: ViewUpdate,
  configInputs: ConfigInputs | undefined
): boolean {
  if (!configInputs) return false;
  const before = configInputs(update.startState);
  const after = configInputs(update.state);
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) {
    if (!Object.is(before[i], after[i])) return true;
  }
  return false;
}

/**
 * Extra state the handlers read beyond document / viewport / selection /
 * marker mode. The caller returns the raw field values; the plugin
 * rebuilds whenever any of them changes identity. Used by `index.ts` to
 * wire in the image context and resolver fields without `shared.ts`
 * having to know about them (which would invert the module layering).
 */
export type ConfigInputs = (state: EditorState) => readonly unknown[];

/**
 * Build a `ViewPlugin` that keeps its decoration set in sync with the
 * editor's selection, viewport, and document. All inline-preview features
 * share the same plugin — it walks the tree once per update and the
 * per-feature handlers contribute their own decorations.
 *
 * Rebuild gating: a naive plugin rebuilds on `selectionSet`, which fires
 * for every keystroke *and* every arrow-key press. But the handlers only
 * consume the selection through line membership (`ctx.isOnCursorLine`),
 * so a cursor moving within a line produces an identical decoration set.
 * We cache the cursor-line key from the last build and skip the rebuild
 * when it — and every other handler input — is unchanged. See
 * `shouldSkipRebuild` for the full invalidation list.
 */
export function createInlinePlugin(
  handlers: HandlerMap,
  configInputs?: ConfigInputs
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      /** Syntax tree the last build walked. Comparing against the current
       *  tree catches incremental background parsing, where the tree
       *  advances without a document change. */
      private tree: Tree;
      /** `cursorLineKey` at the last build. */
      private cursorKey: string;

      constructor(view: EditorView) {
        this.tree = syntaxTree(view.state);
        this.cursorKey = cursorLineKey(
          view.state.doc,
          view.state.selection.ranges
        );
        this.decorations = buildDecorations(view, handlers);
      }

      update(update: ViewUpdate) {
        const tree = syntaxTree(update.state);
        const cursorKey = cursorLineKey(
          update.state.doc,
          update.state.selection.ranges
        );
        const skip = shouldSkipRebuild({
          docChanged: update.docChanged,
          viewportChanged: update.viewportChanged,
          treeChanged: tree !== this.tree,
          modeChanged:
            update.startState.field(markerModeField, false) !==
            update.state.field(markerModeField, false),
          configChanged: configInputsChanged(update, configInputs),
          previousCursorLineKey: this.cursorKey,
          cursorLineKey: cursorKey
        });
        if (skip) return;
        this.tree = tree;
        this.cursorKey = cursorKey;
        this.decorations = buildDecorations(update.view, handlers);
      }
    },
    {
      decorations: (v) => v.decorations
    }
  );
}
