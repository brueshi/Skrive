// The transient link affordance: a small input that floats below the selection
// to add, edit, or remove a link. Opened by the toolbar / bubble link button or
// ⌘K. The key property (Stage 3 gate) is commit-on-intent, discard-on-escape:
// opening it does NOT touch the document — only Enter / Update / Remove dispatch
// a transaction. Escape, or a click outside, dismisses it leaving the buffer
// byte-identical.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { setLink, removeLink } from '../../../lib/projection/commands';
import { useRichUiStore } from './selection-state';
import { useAnchoredBox } from './use-anchored-box';

type Props = { view: EditorView };

export function LinkEditor({ view }: Props) {
  const open = useRichUiStore((s) => s.linkEditor.open);
  const initialHref = useRichUiStore((s) => s.linkEditor.href);
  const editing = useRichUiStore((s) => s.linkEditor.editing);
  const selFrom = useRichUiStore((s) => s.selFrom);
  const selTo = useRichUiStore((s) => s.selTo);
  const geometry = useRichUiStore((s) => s.geometry);
  const close = useRichUiStore((s) => s.closeLinkEditor);

  const [href, setHref] = useState(initialHref);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reduced = useReducedMotion();
  const { ref, pos } = useAnchoredBox(view, selFrom, selTo, open, geometry, 'below');

  // Seed the field from the store each time the editor (re)opens.
  useEffect(() => {
    if (open) setHref(initialHref);
  }, [open, initialHref]);

  // Focus and select the field on open so a paste replaces the prefill.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const run = useCallback(
    (cmd: Command) => {
      cmd(view.state, view.dispatch, view);
    },
    [view]
  );

  const cancel = useCallback(() => {
    close();
    view.focus();
  }, [close, view]);

  const commit = useCallback(() => {
    const trimmed = href.trim();
    if (trimmed) run(setLink(trimmed));
    else if (editing) run(removeLink); // cleared an existing link -> unlink
    close();
    view.focus();
  }, [href, editing, run, close, view]);

  const remove = useCallback(() => {
    run(removeLink);
    close();
    view.focus();
  }, [run, close, view]);

  // A click anywhere outside discards (commit-on-intent: only explicit actions
  // mutate). Capture phase so it fires before the editor handles the click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cancel();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open, cancel, ref]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          className="rich-link-editor"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              commit();
            }}
          >
            <input
              ref={inputRef}
              type="text"
              className="rich-link-input"
              value={href}
              placeholder="Paste or type a link"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancel();
                }
              }}
            />
            <button type="submit" className="rich-link-action">
              {editing ? 'Update' : 'Add'}
            </button>
            {editing && (
              <button
                type="button"
                className="rich-link-action rich-link-remove"
                onClick={remove}
              >
                Remove
              </button>
            )}
          </form>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
