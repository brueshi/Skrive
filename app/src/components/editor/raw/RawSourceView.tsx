// True raw-Markdown source view (SKR-97). A power-user peek over the *same*
// canonical buffer the block surface edits: `body` is already serialized
// Markdown, so this is a plain textarea bound to it. Toggling back to the
// rendered surface remounts BlockEditor, which re-parses the (possibly edited)
// body — so the round trip is the existing parseDocument∘serializeDocument.
//
// Mirrors the BlockEditor contract: uncontrolled (body read once on mount; App
// keys it by tab path), edits flow out as a debounced snapshot, and the
// active-editor flush hook drains the latest value on ⌘S / quit / view toggle.
// A textarea is not the gated keystroke path (that is the contenteditable block
// surface), so a debounced store write is fine here.

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
    // mounted at a time (App swaps on rawView), so registering here is safe.
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
