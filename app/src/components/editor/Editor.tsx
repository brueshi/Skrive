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

type Props = {
  value: string;
  onChange: (next: string) => void;
  /** Lint findings for the active file. Empty array when lint hasn't
   *  run yet or the file is clean. CM6 reads them via a closure that's
   *  re-pointed on every render so reconfigure isn't needed. */
  lintFindings?: LintFinding[];
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

export function Editor({ value, onChange, lintFindings = [] }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const lintFindingsRef = useRef<LintFinding[]>(lintFindings);
  const lintCompartmentRef = useRef<Compartment | null>(null);

  // Keep onChange's reference fresh without re-creating the editor.
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
      if (!update.docChanged) return;
      const next = update.state.doc.toString();
      onChangeRef.current(next);
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

    return () => {
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

  return <div className="editor-host" ref={containerRef} />;
}
