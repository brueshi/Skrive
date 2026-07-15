// The inline-tag (`#`) autocomplete for the bespoke surface. A sibling of
// BlockSlashMenu: same presentation and anchoring, a different trigger and commit.
// The surface detects `#` at a word boundary and drives the query; this lists the
// document's existing tags (fuzzy-filtered) plus a "Create" row for a new name,
// and commits the chosen tag by splicing an InlineTag leaf.
//
// While open, a capture-phase keydown owns Escape, Enter, Tab, and the arrows; a
// space commits the typed name when it is a complete tag (the natural "finish the
// tag" gesture), otherwise it falls through and the surface closes the session,
// leaving the `#` literal. A zero-item query keeps the session open so deleting
// back, or typing a valid name, brings the list (or the Create row) live again.

import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { BlockSurface, TagMenuState } from '../../../lib/blocksurface';
import { fuzzyMatch } from './insert-catalog';
import { useAnchoredRect } from './useAnchoredRect';
import './menus.css';

// A complete tag name: same grammar the parser recognizes. Gates the Create row —
// a partial query (empty, or ending in `/` or `-`) keeps the session open but
// offers nothing to create until it forms a valid name.
const COMPLETE_TAG_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*(?:\/[\p{L}\p{N}_][\p{L}\p{N}_-]*)*$/u;

type TagItem = { name: string; create: boolean };

function TagGlyph() {
  return (
    <svg viewBox="0 0 116.4 115" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="m90.9 23.8c-1.8-1.6-4.6-2.8-7.4-2.5l-18.5 1.6c-2.1 0.2-4.4 1.1-6.1 2.7l-34.6 34.6c-1.3 1.3-2.2 3.4-2.2 5.5 0.2 1.6 0.8 3.6 2.2 5l20.6 20.2c1.5 1.6 3.6 2.4 5.7 2.5 1.8 0 3.9-0.5 5.4-1.8l33.6-33.6c1.6-1.6 2.8-3.6 3-6.6l1.4-18.6c0.1-3.5-1.2-7.1-3.1-9zm-4.3 28.9-34.6 34.3c-0.7 0.8-2.4 0.7-3.3-0.1l-19.8-20.1c-0.8-0.7-0.8-1.9 0.1-2.7l34.3-34.5c0.5-0.4 1-0.8 1.7-0.8l18.6-1.7c1.2-0.1 2.3 0 3.1 0.7 1.1 1 1.8 2 1.6 3.6l-1.8 19.4c0.1 0.7 0.1 1.4 0.1 1.9z"
        fill="currentColor"
      />
      <path
        d="m74.7 31.6c-4.8 0-9.2 4-9.2 8.8s3.7 9.9 9.2 9.9c4.8 0.1 9.1-3.9 9.1-8.7 0.4-4.9-3.8-10-9.1-10zm0 12.8c-1.5 0-3.2-1.4-3.3-3.5 0-1.8 1.5-3.8 3.5-3.8 1.5 0 3.1 1.4 3.1 3.5 0 2.2-2 3.8-3.3 3.8z"
        fill="currentColor"
      />
    </svg>
  );
}

export function BlockTagMenu({ surface }: { surface: BlockSurface }) {
  const [state, setState] = useState<TagMenuState | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const reduced = useReducedMotion();
  const isOpen = state != null;

  useEffect(() => {
    surface.onTagMenu(setState);
    return () => surface.onTagMenu(null);
  }, [surface]);

  // Snapshot the document's tags once per opening, not per keystroke: the walk is
  // O(document), so it must not run on every character typed into the query.
  useEffect(() => {
    if (isOpen) setAllTags(surface.allTagNames());
  }, [isOpen, surface]);

  const query = state?.query ?? '';
  const items = useMemo<TagItem[]>(() => {
    const q = query.toLowerCase();
    const existing = (q ? allTags.filter((n) => fuzzyMatch(q, n.toLowerCase())) : allTags).map(
      (name) => ({ name, create: false })
    );
    // Offer creating the typed name when it is a complete tag not already present.
    const canCreate = COMPLETE_TAG_RE.test(query) && !allTags.includes(query);
    return canCreate ? [{ name: query, create: true }, ...existing] : existing;
  }, [query, allTags]);

  // Reopen starts the highlight at the top; keep it in range as the list narrows.
  useEffect(() => {
    if (isOpen) setActive(0);
  }, [isOpen]);
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        surface.closeTag();
        return;
      }
      // Space commits the typed name when it is a complete tag — the fluid "finish
      // the tag" gesture. Otherwise it flows through and the surface closes the
      // session (the `#…` stays literal text).
      if (e.key === ' ' && COMPLETE_TAG_RE.test(query)) {
        e.preventDefault();
        e.stopPropagation();
        surface.applyTagCommand(query);
        return;
      }
      if (items.length === 0) return; // nothing to navigate; let editing keys through
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, items.length - 1));
      else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
      else {
        const item = items[active];
        if (item) surface.applyTagCommand(item.name);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [state, items, active, query, surface]);

  const { ref, pos } = useAnchoredRect(state?.rect ?? null, isOpen, items.length, 'below');

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={ref}
          className="rich-slash-menu"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          role="listbox"
          aria-label="Insert tag"
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.length === 0 && <div className="rich-slash-empty">No tags yet — keep typing to create one</div>}
          {items.map((item, i) => {
            const isActive = i === active;
            return (
              <button
                key={`${item.create ? 'create:' : ''}${item.name}`}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`rich-slash-item${isActive ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e: MouseEvent) => {
                  e.preventDefault();
                  surface.applyTagCommand(item.name);
                }}
              >
                <span className="rich-slash-icon">
                  <TagGlyph />
                </span>
                <span className="rich-slash-title">
                  {item.create ? `Create #${item.name}` : `#${item.name}`}
                </span>
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
