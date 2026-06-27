// The Rich editing surface: a ProseMirror projection over the canonical
// Markdown body. PM is a projection; the text is the truth.
//
// Wired UNCONTROLLED, deliberately. PM owns its EditorState; React never sees a
// per-keystroke update. Edits flow out only as event-bounded snapshots: a
// debounced serialize on idle, an immediate flush on blur and on unmount (tab /
// file switch). This is the "lag lesson as law" from the master plan — routing
// every keystroke through the store is exactly the wiring that made the old
// editor lag, and it is the one thing this surface must not do.
//
// The body is parsed into PM once, on mount. There is no text -> PM sync after
// that within a session (the master plan's event-bounded rule); a file switch
// remounts via the `key` in App.tsx, re-parsing fresh.

import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, chainCommands } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import {
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  InputRule,
  smartQuotes,
  emDash,
  ellipsis
} from 'prosemirror-inputrules';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { tableEditing, columnResizing, goToNextCell } from 'prosemirror-tables';
import 'prosemirror-tables/style/tables.css';
import type { MarkType } from 'prosemirror-model';
import {
  schema,
  parseDoc,
  serializeDoc,
  dirtyPlugin,
  readSelectionSummary,
  insertHardBreak
} from '../../../lib/projection';
import { usePreferencesStore } from '../../../stores/preferences';
import { setActiveEditorFlush, setActiveRichView } from '../active-editor';
import { Toolbar } from '../menus/Toolbar';
import { SelectionBubble } from '../menus/SelectionBubble';
import { LinkEditor } from '../menus/LinkEditor';
import { RichMenuController } from '../menus/RichMenuController';
import { SlashMenu } from './SlashMenu';
import { PreviewOutlineRail } from '../PreviewOutlineRail';
import { slashPlugin } from './slash-plugin';
import { selectionStatePlugin, useRichUiStore } from './selection-state';
import { now, logDuration, perfEnabled } from '../../../lib/perf';
import 'prosemirror-view/style/prosemirror.css';
import './RichEditor.css';

// Idle delay before serializing the doc out to the store. Long enough that a
// burst of typing coalesces into one snapshot, short enough that the store's
// own save tier sees edits promptly.
const SNAPSHOT_DEBOUNCE_MS = 400;

type RichEditorProps = {
  /** Initial canonical Markdown body. Read once on mount; the surface is
   *  uncontrolled thereafter, so later prop changes are intentionally ignored. */
  body: string;
  /** Receives the serialized canonical body on idle / blur / unmount. */
  onChange: (next: string) => void;
};

// Convert a typed inline-markup span (e.g. `**bold**`) into the corresponding
// mark, the moment the closing delimiter is typed. This is what makes the Rich
// surface feel right for a Markdown-literate writer whose muscle memory types
// the syntax: the delimiters are removed and the content carries the mark,
// rather than sitting there as literal asterisks. (Applying marks via ⌘B/⌘I or
// a future affordance is the other path; both land on the same mark.)
function markInputRule(regexp: RegExp, markType: MarkType): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const captured = match[1];
    if (!captured) return null;
    const tr = state.tr;
    const contentStart = start + match[0].indexOf(captured);
    const contentEnd = contentStart + captured.length;
    // Delete the trailing delimiter first so the leading-delete offsets hold.
    tr.delete(contentEnd, end);
    tr.delete(start, contentStart);
    tr.addMark(start, start + captured.length, markType.create());
    // Don't let the mark bleed into whatever the writer types next.
    tr.removeStoredMark(markType);
    return tr;
  });
}

// Turn a line that is exactly `---`, `***`, or `___` into a divider the moment
// the third character lands, then drop a fresh paragraph below it for the cursor
// so the writer keeps typing past the rule rather than landing on an atom.
function horizontalRuleInputRule(): InputRule {
  return new InputRule(/^(?:---|\*\*\*|___)$/, (state, _match, start) => {
    const tr = state.tr;
    const $start = tr.doc.resolve(start);
    const hr = schema.nodes.horizontal_rule.create();
    const para = schema.nodes.paragraph.create();
    // Replace the whole textblock (its `---` content and all) with the rule,
    // then insert the trailing paragraph just after the rule's single position.
    tr.replaceRangeWith($start.before(), $start.after(), hr);
    const afterRule = $start.before() + hr.nodeSize;
    tr.insert(afterRule, para);
    tr.setSelection(TextSelection.create(tr.doc, afterRule + 1));
    return tr;
  });
}

function buildPlugins(smartTypography: boolean) {
  const listItem = schema.nodes.list_item;
  return [
    history(),
    inputRules({
      rules: [
        // Smart typography first so the prose substitutions (curly quotes,
        // em dash, ellipsis) run before the structural rules. PM's
        // inputRules plugin skips these inside code blocks automatically,
        // so source stays straight-quoted. Off unless the pref is set.
        ...(smartTypography ? [...smartQuotes, emDash, ellipsis] : []),
        // Inline marks. strong before em so `**x**` matches the double rule
        // first; the em rule's lookbehind keeps it from firing on a `**` pair.
        markInputRule(/\*\*([^*]+)\*\*$/, schema.marks.strong),
        markInputRule(/(?<!\*)\*([^*\s][^*]*)\*$/, schema.marks.em),
        markInputRule(/`([^`]+)`$/, schema.marks.code),
        wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
        wrappingInputRule(
          /^\s*(\d+)([.)])\s$/,
          schema.nodes.ordered_list,
          (match) => ({ start: Number(match[1] ?? '1'), delimiter: match[2] ?? '.' })
        ),
        textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({
          level: (match[1] ?? '#').length
        })),
        wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
        horizontalRuleInputRule()
      ]
    }),
    // Before the editing keymaps: while the slash menu is open it must claim
    // Enter / Arrow / Tab / Escape to drive the menu rather than split a list
    // item or insert a newline.
    slashPlugin(),
    keymap({
      'Shift-Enter': insertHardBreak,
      Enter: splitListItem(listItem),
      // Tab / Shift-Tab move between cells inside a table, else nest / un-nest a
      // list item. goToNextCell returns false outside a table and sinkListItem
      // returns false outside a list, so the chain is inert in plain prose
      // rather than swallowing Tab everywhere. Mod-[ / Mod-] keep the explicit
      // list variant for when the cursor is in a list nested inside a cell.
      Tab: chainCommands(goToNextCell(1), sinkListItem(listItem)),
      'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(listItem)),
      'Mod-]': sinkListItem(listItem),
      'Mod-[': liftListItem(listItem)
    }),
    keymap({
      'Mod-b': toggleMark(schema.marks.strong),
      'Mod-i': toggleMark(schema.marks.em),
      'Mod-`': toggleMark(schema.marks.code),
      // Open the link affordance for the current selection (or the link under
      // the cursor). Opens UI only — no document mutation until the writer
      // commits — so an escaped ⌘K leaves the buffer untouched.
      'Mod-k': (state) => {
        const summary = readSelectionSummary(state);
        if (summary.empty && !summary.link) return false;
        useRichUiStore.getState().openLinkEditor(summary.linkHref ?? '', summary.link);
        return true;
      },
      'Mod-z': undo,
      'Mod-y': redo,
      'Shift-Mod-z': redo
    }),
    keymap(baseKeymap),
    // Pushes a tiny, rAF-coalesced selection summary to the affordance store so
    // the toolbar / bubble reflect live state without re-rendering the editor.
    selectionStatePlugin(),
    // Cell selection, in-table arrow/Tab navigation, and the structural cell
    // commands (add/remove row/column). columnResizing adds drag-to-resize
    // handles; the resulting colwidth is visual-only and never serialized — GFM
    // has no column widths, so a width-only change is semantically equal to the
    // source and the idempotence guard restores the original bytes.
    columnResizing(),
    tableEditing(),
    dirtyPlugin
  ];
}

export function RichEditor({ body, onChange }: RichEditorProps): React.ReactElement {
  const mountRef = useRef<HTMLDivElement | null>(null);
  // The mounted EditorView, surfaced to React once (after the mount effect runs)
  // so the affordance components can dispatch into it. Setting this re-renders
  // RichEditor a single time to mount those siblings; the `[]`-dep effect never
  // re-runs, so the PM-managed editor div is created exactly once.
  const [view, setView] = useState<EditorView | null>(null);
  // The editor-agnostic menu controller over this view, driving the shared
  // toolbar / bubble / link editor. Recreated if the view is replaced.
  const menuController = useMemo(() => (view ? new RichMenuController(view) : null), [view]);
  useEffect(() => () => menuController?.destroy(), [menuController]);
  // Keep the latest onChange without re-running the mount effect.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Capture the body at mount; the surface is uncontrolled afterwards.
  const initialBodyRef = useRef(body);
  // The ProseMirror content element (view.dom), handed to the outline rail so
  // it can read the live headings. Populated once the view is constructed.
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const t0 = now();
      const md = serializeDoc(view.state.doc);
      logDuration(`rich serializeDoc (${md.length} chars)`, t0);
      onChangeRef.current(md);
    };
    const scheduleSnapshot = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, SNAPSHOT_DEBOUNCE_MS);
    };

    const view = new EditorView(el, {
      state: EditorState.create({
        doc: parseDoc(initialBodyRef.current),
        // Read once at construction — the surface is uncontrolled, so
        // toggling the pref takes effect when the document is reopened.
        plugins: buildPlugins(usePreferencesStore.getState().smartTypography)
      }),
      // Uncontrolled: PM applies the transaction to its own state; the only
      // outward effect is the debounced snapshot. No per-keystroke React write.
      dispatchTransaction(tr) {
        const t0 = now();
        const next = view.state.apply(tr);
        view.updateState(next);
        // Per-keystroke cost: transaction apply (incl. the dirty plugin's
        // appendTransaction) plus the DOM update. Only the slow ones are logged
        // so a steady stream of fast keystrokes doesn't drown the signal.
        if (perfEnabled && tr.docChanged) {
          const dt = performance.now() - t0;
          if (dt > 4) {
            // eslint-disable-next-line no-console
            console.log(
              `[skrive-perf] rich keystroke (doc size=${next.doc.nodeSize}): ${dt.toFixed(1)}ms`
            );
          }
        }
        if (tr.docChanged) scheduleSnapshot();
      },
      handleDOMEvents: {
        blur: () => {
          flush();
          return false;
        }
      }
    });

    // Expose this surface's flush so the pre-quit / save paths can drain a
    // pending snapshot into the store before saves run, and the view so the
    // palette's Insert group can dispatch affordance commands into it.
    setActiveEditorFlush(flush);
    setActiveRichView(view);
    // The editable element is the outline rail's content node — its headings
    // are the ones the reader sees and scrolls through.
    contentRef.current = view.dom as HTMLDivElement;
    setView(view);

    return () => {
      flush(); // persist pending edits before teardown (tab / file switch)
      setActiveEditorFlush(null);
      setActiveRichView(null);
      contentRef.current = null;
      view.destroy();
    };
  }, []);

  return (
    <div className="rich-surface">
      {menuController && <Toolbar controller={menuController} />}
      {/* Positioned host so the absolutely-placed outline rail anchors to the
          editor area (below the toolbar), mirroring the preview's host. */}
      <div className="rich-body">
        <div className="rich-editor" ref={mountRef} />
        {view && (
          <PreviewOutlineRail
            scrollerRef={mountRef}
            contentRef={contentRef}
            renderKey={initialBodyRef.current}
          />
        )}
      </div>
      {menuController && <SelectionBubble controller={menuController} />}
      {menuController && <LinkEditor controller={menuController} />}
      {view && <SlashMenu view={view} />}
    </div>
  );
}
