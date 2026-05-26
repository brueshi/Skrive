// CodeMirror 6 editor wrapped as a controlled React component.
//
// Contract:
//   - The `value` prop is the source of truth for document content.
//   - All edits flow through CodeMirror's transaction system. There are no
//     imperative mutations from the parent or from this component.
//   - When the user edits in the view, the listener writes back via
//     `onChange`. When the parent assigns a new `value` (e.g. on file
//     load), a separate effect dispatches a single replace transaction.
//
// The "controlled" part is enforced by always going through `view.dispatch`
// for any document change so we never have two sources of truth fighting
// each other.

import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import type { Command } from '@codemirror/view';
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection
} from '@codemirror/view';
import {
  history,
  defaultKeymap,
  historyKeymap,
  indentMore,
  indentLess
} from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { forceLinting } from '@codemirror/lint';
import { GFM } from '@lezer/markdown';
import type { LintFinding } from '@skrive/shared';
import { skriveTheme } from './skrive-theme';
import { inlinePreview } from './decorations';
import { skriveLintExtension } from './lint-extension';
import { clipboardCopyExport, clipboardPasteImport } from './clipboard';
import type { PendingSelection } from '../../stores/project';

type Props = {
  value: string;
  onChange: (next: string) => void;
  /** Lint findings for the active file. Empty array when lint hasn't
   *  run yet or the file is clean. CM6 reads them via a closure that's
   *  re-pointed on every render so reconfigure isn't needed. */
  lintFindings?: LintFinding[];
  /** Initial cursor position applied to the freshly-mounted view.
   *  `line` is 1-indexed (CM6's line.number); `column` is 0-indexed
   *  UTF-16. Subsequent mounts (different file) recreate the editor
   *  via the parent's `key={tab.path}`. */
  initialCursorLine?: number;
  initialCursorColumn?: number;
  /** Initial scrollTop in pixels. Applied once after the view is
   *  mounted; later scrolls are user-driven. */
  initialScrollTop?: number;
  /** One-shot "go here and select N units" request. Tracked by nonce
   *  so identical line/column requests still fire (search-jump back to
   *  the same hit). The parent clears via onPendingSelectionApplied. */
  pendingSelection?: PendingSelection | null;
  onPendingSelectionApplied?: () => void;
  /** Cursor changes (selection.head). Fires on every selection change
   *  regardless of doc edits — the parent decides what to persist. */
  onCursorChange?: (line: number, column: number) => void;
  /** Editor scroll changes. Fires on the DOM scroll event of the
   *  editor scroller. */
  onScrollTopChange?: (top: number) => void;
};

// Tab/Shift-Tab indent or outdent list items when the cursor (or every
// line in the selection) sits on a markdown list line. Outside list
// context the commands return false so default Tab handling runs —
// important because writers occasionally indent prose, and indenting
// prose by 4+ spaces would silently turn it into a CommonMark code
// block. Gating on list context avoids that footgun.
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;

const allSelectionLinesAreLists = (v: EditorView): boolean => {
  const { state } = v;
  for (const range of state.selection.ranges) {
    const fromLine = state.doc.lineAt(range.from).number;
    const toLine = state.doc.lineAt(range.to).number;
    for (let n = fromLine; n <= toLine; n++) {
      if (!LIST_LINE.test(state.doc.line(n).text)) return false;
    }
  }
  return true;
};

// Always returns true when the gesture lands on a list line — even if
// indentLess can't outdent further (e.g. Shift-Tab on a top-level
// bullet) — so focus doesn't escape the editor on a no-op outdent.
const tabIndentListItem: Command = (v) => {
  if (!allSelectionLinesAreLists(v)) return false;
  indentMore(v);
  return true;
};

const shiftTabOutdentListItem: Command = (v) => {
  if (!allSelectionLinesAreLists(v)) return false;
  indentLess(v);
  return true;
};

export function Editor({
  value,
  onChange,
  lintFindings = [],
  initialCursorLine,
  initialCursorColumn,
  initialScrollTop,
  pendingSelection,
  onPendingSelectionApplied,
  onCursorChange,
  onScrollTopChange
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  const onScrollTopChangeRef = useRef(onScrollTopChange);
  const lintFindingsRef = useRef<LintFinding[]>(lintFindings);
  const lintCompartmentRef = useRef<Compartment | null>(null);
  const lastCursorRef = useRef<{ line: number; column: number }>({
    line: initialCursorLine ?? 1,
    column: initialCursorColumn ?? 0
  });

  // Keep callback refs fresh without re-creating the editor.
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onCursorChangeRef.current = onCursorChange;
  }, [onCursorChange]);
  useEffect(() => {
    onScrollTopChangeRef.current = onScrollTopChange;
  }, [onScrollTopChange]);

  // Mirror findings into a ref so the lint source closure always
  // reads the current set without re-creating the extension.
  useEffect(() => {
    lintFindingsRef.current = lintFindings;
    const view = viewRef.current;
    if (view) forceLinting(view);
  }, [lintFindings]);

  // Construct the EditorView once on mount. We deliberately do *not*
  // reconstruct the view on `value` changes — that's what the second
  // effect handles via a transaction.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const next = update.state.doc.toString();
        onChangeRef.current(next);
      }
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        const column = head - line.from;
        const last = lastCursorRef.current;
        if (last.line !== line.number || last.column !== column) {
          lastCursorRef.current = { line: line.number, column };
          onCursorChangeRef.current?.(line.number, column);
        }
      }
    });

    const lintCompartment = new Compartment();
    lintCompartmentRef.current = lintCompartment;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          markdown({ extensions: GFM }),
          clipboardCopyExport(),
          clipboardPasteImport(),
          ...inlinePreview(),
          // Hand spellcheck off to the OS / webview. The system runs a
          // grade spellchecker on contenteditable surfaces; the
          // markdown-aware decorations in `decorations/spellcheck.ts`
          // skip code, URLs, and frontmatter so the OS doesn't
          // autocorrect what shouldn't be prose.
          EditorView.contentAttributes.of({ spellcheck: 'true' }),
          keymap.of([
            { key: 'Tab', run: tabIndentListItem },
            { key: 'Shift-Tab', run: shiftTabOutdentListItem },
            ...defaultKeymap,
            ...historyKeymap
          ]),
          skriveTheme,
          updateListener,
          EditorView.lineWrapping,
          lintCompartment.of(
            skriveLintExtension(() => lintFindingsRef.current)
          )
        ]
      }),
      parent: container
    });

    viewRef.current = view;

    // Apply initial cursor + scroll once the view exists. Cursor lives
    // in EditorState; scroll is a DOM property of `view.scrollDOM`.
    if (
      typeof initialCursorLine === 'number' &&
      initialCursorLine >= 1 &&
      initialCursorLine <= view.state.doc.lines
    ) {
      const line = view.state.doc.line(initialCursorLine);
      const col = Math.min(
        Math.max(initialCursorColumn ?? 0, 0),
        line.length
      );
      const pos = line.from + col;
      view.dispatch({ selection: { anchor: pos, head: pos } });
      lastCursorRef.current = { line: initialCursorLine, column: col };
    }
    if (typeof initialScrollTop === 'number' && initialScrollTop > 0) {
      view.scrollDOM.scrollTop = initialScrollTop;
    }

    const handleScroll = () => {
      onScrollTopChangeRef.current?.(view.scrollDOM.scrollTop);
    };
    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External writes to `value` (parent state, e.g. opening a different
  // file) are reflected by dispatching a single replace transaction. We
  // guard against echoing edits we just emitted by comparing against the
  // live doc.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value }
      });
    }
  }, [value]);

  // Apply a pending selection request (search-jump, backlink-click).
  // We track the last-applied nonce so the same selection request
  // doesn't re-apply on unrelated re-renders, but two distinct requests
  // to the same (line, column) still fire because the nonce changes.
  const lastSelectionNonceRef = useRef<number>(-1);
  const onPendingSelectionAppliedRef = useRef(onPendingSelectionApplied);
  useEffect(() => {
    onPendingSelectionAppliedRef.current = onPendingSelectionApplied;
  }, [onPendingSelectionApplied]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !pendingSelection) return;
    if (pendingSelection.nonce === lastSelectionNonceRef.current) return;
    lastSelectionNonceRef.current = pendingSelection.nonce;
    const doc = view.state.doc;
    const lineNo = Math.min(Math.max(pendingSelection.line, 1), doc.lines);
    const lineInfo = doc.line(lineNo);
    const anchor = Math.min(
      lineInfo.from + Math.max(pendingSelection.column, 0),
      lineInfo.to
    );
    const head = Math.min(
      anchor + Math.max(pendingSelection.length, 0),
      lineInfo.to
    );
    view.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(anchor, { y: 'center' })
    });
    view.focus();
    onPendingSelectionAppliedRef.current?.();
  }, [pendingSelection]);

  return <div className="editor-host" ref={containerRef} />;
}
