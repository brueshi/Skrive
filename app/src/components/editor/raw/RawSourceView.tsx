// Raw-Markdown editor (SKR-97, promoted to the primary `.md` editing surface in
// SKR-197). A plain textarea bound to the tab `body`, which is already the
// canonical Markdown: editing is text -> text, and the save writes those bytes
// verbatim — there is no parse -> model -> serialize round trip on this path, so
// the SKR-153 fidelity bug class cannot recur here. The block model never touches
// `.md`; the preview (MarkdownView) renders via the unified md -> HTML pipeline.
//
// Uncontrolled (body read once on mount; App keys it by tab path), edits flow out
// as a debounced snapshot (plus an undebounced onLiveInput for the live preview),
// and the active-editor flush hook drains the latest value on S / quit / layout
// switch. A textarea is not the gated keystroke path (that is the contenteditable
// block surface), so a debounced store write is fine here.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { setActiveEditorFlush } from '../active-editor';
import './RawSourceView.css';

/** Where the writer was: caret/selection and scroll offset. Owned by whoever
 *  outlives the textarea (MarkdownView holds it across a layout cycle, SKR-183). */
export type RawViewState = {
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
};

type Props = {
  /** Initial canonical Markdown body. Read once on mount; uncontrolled thereafter. */
  body: string;
  /** Receives the textarea value on the debounced snapshot, on blur, and on flush. */
  onChange: (next: string) => void;
  /**
   * Fires on every input with the live value, undebounced — for a live preview
   * that must feel instant. The debounced `onChange` remains the store / save /
   * lint path; this is a separate, cheap, presentation-only signal.
   */
  onLiveInput?: (next: string) => void;
  /** Accessible label for the textarea. Defaults to the Markdown-source wording;
   *  plain-text mode (SKR-204) passes its own. */
  ariaLabel?: string;
  /**
   * Caret + scroll to restore on mount, or null on a document's first mount. A
   * GETTER, not a value: the outgoing textarea reports its state during the very
   * commit that mounts this one, so a prop read at render time would always predate
   * the handoff.
   */
  getInitialViewState?: () => RawViewState | null;
  /** Reports caret + scroll at unmount, so the next mount can restore them. */
  onViewStateChange?: (state: RawViewState) => void;
  /** Take focus on mount. Set when this mount is a layout cycle, not a file open. */
  autoFocus?: boolean;
};

const SNAPSHOT_DELAY_MS = 250;

export function RawSourceView({
  body,
  onChange,
  onLiveInput,
  ariaLabel = 'Raw Markdown source',
  getInitialViewState,
  onViewStateChange,
  autoFocus = false
}: Props): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLiveInputRef = useRef(onLiveInput);
  onLiveInputRef.current = onLiveInput;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onViewStateChangeRef = useRef(onViewStateChange);
  onViewStateChangeRef.current = onViewStateChange;
  const getInitialViewStateRef = useRef(getInitialViewState);
  getInitialViewStateRef.current = getInitialViewState;

  useEffect(() => {
    // The node is captured HERE, at mount, not read from the ref inside cleanup.
    // React detaches a host ref (`ref.current = null`) before it runs the effect's
    // destructor, so the old `const el = textareaRef.current` in the cleanup path
    // always saw null and the unmount flush silently drained nothing (SKR-183).
    // Every layout switch happens to call flushActiveEditor() first, or blurs the
    // textarea, so no edit was actually lost — but the safety net BlockEditor's
    // cleanup cites (SKR-154 / F02) did not exist on this path. A closed-over node
    // outlives the ref.
    const el = textareaRef.current;
    const flush = () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (el) onChangeRef.current(el.value);
    };
    // Single-slot flush hook, shared with BlockEditor; only one surface is
    // mounted at a time (App swaps by tab mode / layout), so registering here
    // is safe.
    setActiveEditorFlush(flush);
    return () => {
      flush();
      setActiveEditorFlush(null);
    };
    // Uncontrolled: body is intentionally read once. App remounts per file/view via key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The writer's place in the text, handed from the outgoing textarea to the incoming
  // one. This MUST be a layout effect, not a passive one: React defers a deleted
  // subtree's useEffect cleanup to the passive phase, which runs *after* the new
  // subtree's layout effects — the outgoing caret would arrive too late to restore.
  // Layout-effect cleanups for deletions run in the mutation phase, before any of it.
  //
  // Restoring before paint also means the writer never sees a flash at scroll-top with
  // the caret at 0. Order is deliberate: focus, then scroll, then selection LAST —
  // setSelectionRange on a focused textarea scrolls the caret into view, so when a
  // width change (raw <-> split rewraps the text) puts the saved scrollTop and the
  // caret in conflict, the caret wins. That is the promise the reference behaviour
  // makes: the same sentence stays under your eyes, not the same pixel offset.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (autoFocus) el.focus();
    const initial = getInitialViewStateRef.current?.();
    if (initial) {
      el.scrollTop = initial.scrollTop;
      el.setSelectionRange(initial.selectionStart, initial.selectionEnd);
    }
    return () => {
      onViewStateChangeRef.current?.({
        selectionStart: el.selectionStart,
        selectionEnd: el.selectionEnd,
        scrollTop: el.scrollTop
      });
    };
    // Mount-only: a restore is a handoff between two textareas, never a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onInput = () => {
    const el = textareaRef.current;
    // Live, undebounced signal for the preview; the store write below stays
    // debounced.
    if (el && onLiveInputRef.current) onLiveInputRef.current(el.value);
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const cur = textareaRef.current;
      if (cur) onChangeRef.current(cur.value);
    }, SNAPSHOT_DELAY_MS);
  };

  return (
    <div className="raw-source-view">
      <textarea
        ref={textareaRef}
        className="raw-source-textarea"
        defaultValue={body}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label={ariaLabel}
        onInput={onInput}
        onBlur={() => {
          const el = textareaRef.current;
          if (el) onChangeRef.current(el.value);
        }}
      />
    </div>
  );
}
