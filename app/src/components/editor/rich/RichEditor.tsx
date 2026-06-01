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

import { useEffect, useRef } from 'react';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import {
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  InputRule
} from 'prosemirror-inputrules';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import type { MarkType } from 'prosemirror-model';
import { schema, parseDoc, serializeDoc, dirtyPlugin } from '../../../lib/projection';
import { setActiveEditorFlush } from '../active-editor';
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

function buildPlugins() {
  const listItem = schema.nodes.list_item;
  return [
    history(),
    inputRules({
      rules: [
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
        horizontalRuleInputRule()
      ]
    }),
    keymap({
      Enter: splitListItem(listItem),
      'Mod-[': liftListItem(listItem),
      'Mod-]': sinkListItem(listItem),
      'Shift-Tab': liftListItem(listItem)
    }),
    keymap({
      'Mod-b': toggleMark(schema.marks.strong),
      'Mod-i': toggleMark(schema.marks.em),
      'Mod-`': toggleMark(schema.marks.code),
      'Mod-z': undo,
      'Mod-y': redo,
      'Shift-Mod-z': redo
    }),
    keymap(baseKeymap),
    dirtyPlugin
  ];
}

export function RichEditor({ body, onChange }: RichEditorProps): React.ReactElement {
  const mountRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest onChange without re-running the mount effect.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Capture the body at mount; the surface is uncontrolled afterwards.
  const initialBodyRef = useRef(body);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      onChangeRef.current(serializeDoc(view.state.doc));
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
        plugins: buildPlugins()
      }),
      // Uncontrolled: PM applies the transaction to its own state; the only
      // outward effect is the debounced snapshot. No per-keystroke React write.
      dispatchTransaction(tr) {
        const next = view.state.apply(tr);
        view.updateState(next);
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
    // pending snapshot into the store before saves run.
    setActiveEditorFlush(flush);

    return () => {
      flush(); // persist pending edits before teardown (tab / file switch)
      setActiveEditorFlush(null);
      view.destroy();
    };
  }, []);

  return <div className="rich-editor" ref={mountRef} />;
}
