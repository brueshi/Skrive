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

import { useEffect, useRef } from 'react';
import { setActiveEditorFlush } from '../active-editor';
import './RawSourceView.css';

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
};

const SNAPSHOT_DELAY_MS = 250;

export function RawSourceView({
  body,
  onChange,
  onLiveInput
}: Props): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLiveInputRef = useRef(onLiveInput);
  onLiveInputRef.current = onLiveInput;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const flush = () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const el = textareaRef.current;
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
        aria-label="Raw Markdown source"
        onInput={onInput}
        onBlur={() => {
          const el = textareaRef.current;
          if (el) onChangeRef.current(el.value);
        }}
      />
    </div>
  );
}
