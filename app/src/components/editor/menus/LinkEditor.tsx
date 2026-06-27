// The transient link affordance: a small input that floats below the selection to
// add, edit, or remove a link. Opened by the toolbar / bubble link button. The key
// property: commit-on-intent, discard-on-escape — opening it does NOT touch the
// document; only Add / Update / Remove dispatch through the controller. Escape, or
// a click outside, dismisses it leaving the buffer unchanged. Shared by both
// editors via MenuController.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { MenuController } from './controller';
import { useAnchoredRect } from './useAnchoredRect';
import './menus.css';

export function LinkEditor({ controller }: { controller: MenuController }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { open, href: initialHref, editing } = snap.link;
  const reduced = useReducedMotion();

  const [href, setHref] = useState(initialHref);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { ref, pos } = useAnchoredRect(controller.anchorRect(), open, snap.rev, 'below');

  // Seed the field from the controller each time it (re)opens.
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

  const cancel = useCallback(() => {
    controller.closeLinkEditor();
    controller.focusEditor();
  }, [controller]);

  const commit = useCallback(() => {
    const trimmed = href.trim();
    if (trimmed) controller.commitLink(trimmed);
    else if (editing) controller.removeLink(); // cleared an existing link -> unlink
    else controller.closeLinkEditor();
    controller.focusEditor();
  }, [href, editing, controller]);

  const remove = useCallback(() => {
    controller.removeLink();
    controller.focusEditor();
  }, [controller]);

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
              <button type="button" className="rich-link-action rich-link-remove" onClick={remove}>
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
