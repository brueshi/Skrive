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
import {
  inlinePreview,
  setImageContext,
  setImageResolver,
  setMarkerMode
} from './decorations';
import { usePreferencesStore } from '../../stores/preferences';
import { skriveLintExtension } from './lint-extension';
import { clipboardCopyExport, clipboardPasteImport } from './clipboard';
import { skriveAssetResolver } from '../../lib/preview/imageResolver';
import { setActiveEditorFlush } from './active-editor';
import type { PendingSelection } from '../../stores/project';

// The Text surface owns its state; the store gets debounced snapshots, never a
// per-keystroke write. Typing into the store on every keystroke re-rendered the
// whole workspace (Preview included) each keystroke — the controlled-component
// lag the projection work made law to avoid. A short idle delay coalesces a
// typing burst into one sync; ⌘S / blur / quit / unmount flush immediately.
//
// This is also the single typing→preview latency knob: Preview.tsx renders
// directly from the store snapshot with no debounce of its own (it used to
// add 150ms on top, which coalesced nothing at this cadence — see the
// header comment there). Word count, preview, and outline all read the
// same snapshot, so they move together.
const SYNC_DEBOUNCE_MS = 250;

type Props = {
  value: string;
  onChange: (next: string) => void;
  /** Active document's project-relative path and the project root, used to
   *  resolve relative image URLs through the skrive-asset protocol. Set once
   *  at mount; the editor remounts per file (keyed on path upstream). */
  filePath?: string | null;
  projectRoot?: string;
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
  filePath = null,
  projectRoot = '',
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
  // The Text surface's Markdown marker treatment (raw / recessed / concealed).
  // Seeded into editor state at mount and pushed live on change.
  const markerMode = usePreferencesStore((s) => s.markerMode);
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  const onScrollTopChangeRef = useRef(onScrollTopChange);
  const lintFindingsRef = useRef<LintFinding[]>(lintFindings);
  const lintCompartmentRef = useRef<Compartment | null>(null);
  const lastCursorRef = useRef<{ line: number; column: number }>({
    line: initialCursorLine ?? 1,
    column: initialCursorColumn ?? 0
  });
  // Debounced store sync. `pending` holds the latest body / cursor not yet
  // pushed to the store; the timer flushes them after a typing pause.
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{
    body: string | null;
    cursor: { line: number; column: number } | null;
  }>({ body: null, cursor: null });
  // The last body we pushed to the store. Because the push is debounced, the
  // `value` prop lags the live doc; when it catches up it equals this, and the
  // write-back effect must treat that as our own echo (not an external change)
  // — otherwise it would replace newer keystrokes with the stale flushed value.
  const lastEmittedRef = useRef<string>(value);

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

    // Push buffered body / cursor into the store. Synchronous; safe to call
    // from blur, ⌘S, quit, and unmount.
    const flushSync = () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      const pending = pendingRef.current;
      if (pending.body !== null) {
        lastEmittedRef.current = pending.body;
        onChangeRef.current(pending.body);
      }
      if (pending.cursor) {
        onCursorChangeRef.current?.(pending.cursor.line, pending.cursor.column);
      }
      pendingRef.current = { body: null, cursor: null };
    };
    const scheduleSync = () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(flushSync, SYNC_DEBOUNCE_MS);
    };

    const updateListener = EditorView.updateListener.of((update) => {
      let dirty = false;
      if (update.docChanged) {
        pendingRef.current.body = update.state.doc.toString();
        dirty = true;
      }
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        const column = head - line.from;
        const last = lastCursorRef.current;
        if (last.line !== line.number || last.column !== column) {
          lastCursorRef.current = { line: line.number, column };
          pendingRef.current.cursor = { line: line.number, column };
          dirty = true;
        }
      }
      if (dirty) scheduleSync();
    });

    // Persist immediately when the surface loses focus, so clicking away or
    // tabbing out never strands the last keystrokes in the debounce window.
    const blurHandler = EditorView.domEventHandlers({
      blur: () => {
        flushSync();
        return false;
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
          // Lezer is the Text surface's LOCAL incremental highlighter only — it
          // feeds CM6 syntax coloring and the decoration tree-walk, nothing more.
          // mdast (mdast-util-from-markdown) is the single structural authority
          // for the projection, lint, and link graph; the preview renders via
          // remark->rehype. Do not grow a document model out of this tree.
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
          blurHandler,
          EditorView.lineWrapping,
          lintCompartment.of(
            skriveLintExtension(() => lintFindingsRef.current)
          )
        ]
      }),
      parent: container
    });

    viewRef.current = view;

    // Expose this surface's flush so ⌘S and the pre-quit handler drain the
    // pending snapshot into the store before saves read it.
    setActiveEditorFlush(flushSync);

    // Project-aware image resolution. Set once here; the editor remounts on
    // file switch (keyed on path upstream), so the context stays correct.
    view.dispatch({
      effects: [
        setImageResolver.of(skriveAssetResolver),
        setImageContext.of({ projectRoot, filePath }),
        // Seed from the live pref, not the captured render value, so the
        // initial paint already matches the writer's choice (no flash).
        setMarkerMode.of(usePreferencesStore.getState().markerMode)
      ]
    });

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
      flushSync(); // persist the last edits before teardown (file/tab switch)
      setActiveEditorFlush(null);
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
    // A `value` equal to what we last emitted is our own (debounce-lagged)
    // edit echoing back — ignore it, even if the live doc has since moved on.
    if (value === lastEmittedRef.current) return;
    // Otherwise it's an external change (file reload, rename): apply it and let
    // it supersede any buffered local body.
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value }
      });
    }
    lastEmittedRef.current = value;
    pendingRef.current.body = null;
  }, [value]);

  // Push marker-mode changes (Settings) into the live editor. The decoration
  // plugin rebuilds when the field changes, so this re-renders the markers
  // without remounting the surface.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setMarkerMode.of(markerMode) });
  }, [markerMode]);

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
