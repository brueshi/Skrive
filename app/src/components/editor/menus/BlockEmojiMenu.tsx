// The emoji (`:`) picker for the bespoke surface. A sibling of BlockSlashMenu and
// BlockTagMenu — same popover surface, same anchoring, same capture-phase key
// ownership — but a GRID rather than a list, because emoji are recognised by
// sight and a one-per-row list would make browsing 1800 of them absurd.
//
// The dataset is fetched on first open and never again (lib/emoji). Until it
// resolves the popover shows a quiet loading row rather than nothing, so a slow
// first open reads as "working" instead of "broken". Reopening is synchronous:
// `loadedEmoji()` hands back the cached catalog, so there is no flash of loading
// on every subsequent `:`.
//
// Two openings, one component. A SEEDED session (chosen from the Insert catalog)
// browses the whole catalog in CLDR group order with section headers; a typed
// `:query` shows ranked matches with no headers, since a ranked list sectioned by
// group would fight its own ordering.

import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { BlockSurface, EmojiMenuState } from '../../../lib/blocksurface';
import { EMOJI_GROUPS, loadEmoji, loadedEmoji, searchEmoji, type EmojiEntry } from '../../../lib/emoji';
import { useAnchoredRect } from './useAnchoredRect';
import './menus.css';

/** Columns in the grid. Fixed rather than measured: the popover has a fixed
 *  width, so the column count is a design constant and arrow-key navigation can
 *  rely on it without reading layout back. */
export const COLUMNS = 9;

/** A row is either a section header (browse mode) or a run of emoji. Flattening
 *  to rows up front lets the arrow keys walk a simple index and keeps the render
 *  a straight map. */
export type Row = { kind: 'header'; name: string } | { kind: 'emoji'; items: EmojiEntry[] };

export function toRows(entries: EmojiEntry[], sectioned: boolean): Row[] {
  const rows: Row[] = [];
  const pushRuns = (items: EmojiEntry[]) => {
    for (let i = 0; i < items.length; i += COLUMNS) {
      rows.push({ kind: 'emoji', items: items.slice(i, i + COLUMNS) });
    }
  };
  if (!sectioned) {
    pushRuns(entries);
    return rows;
  }
  for (const group of EMOJI_GROUPS) {
    const inGroup = entries.filter((e) => e.group === group.id);
    if (inGroup.length === 0) continue;
    rows.push({ kind: 'header', name: group.name });
    pushRuns(inGroup);
  }
  return rows;
}

/** The flat list of selectable entries, in the order the grid shows them — the
 *  order the arrow keys walk. Exported with {@link toRows} and {@link COLUMNS}
 *  because that correspondence IS the keyboard model: ArrowDown adds COLUMNS to
 *  a flat index and lands a row below only while flat order and visual order are
 *  the same sequence. */
export function flatten(rows: Row[]): EmojiEntry[] {
  const out: EmojiEntry[] = [];
  for (const row of rows) if (row.kind === 'emoji') out.push(...row.items);
  return out;
}

export function BlockEmojiMenu({ surface }: { surface: BlockSurface }) {
  const [state, setState] = useState<EmojiMenuState | null>(null);
  const [entries, setEntries] = useState<EmojiEntry[] | null>(loadedEmoji());
  const [active, setActive] = useState(0);
  const reduced = useReducedMotion();
  const isOpen = state != null;

  useEffect(() => {
    surface.onEmojiMenu(setState);
    return () => surface.onEmojiMenu(null);
  }, [surface]);

  // Fetch on first open only. A failed load leaves `entries` null, which renders
  // as the empty state rather than throwing — the writer can close and retry, and
  // loadEmoji() clears its in-flight promise so the retry actually re-fetches.
  useEffect(() => {
    if (!isOpen || entries) return;
    let cancelled = false;
    void loadEmoji().then(
      (all) => {
        if (!cancelled) setEntries(all);
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen, entries]);

  const query = state?.query ?? '';
  const sectioned = query.trim().length === 0;
  const rows = useMemo(() => {
    if (!entries) return [];
    return toRows(searchEmoji(entries, query), sectioned);
  }, [entries, query, sectioned]);
  const items = useMemo(() => flatten(rows), [rows]);

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
        surface.closeEmoji();
        return;
      }
      if (items.length === 0) return; // nothing to navigate; let editing keys through
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const last = items.length - 1;
      if (e.key === 'ArrowRight') setActive((i) => Math.min(i + 1, last));
      else if (e.key === 'ArrowLeft') setActive((i) => Math.max(i - 1, 0));
      // Vertical movement is a whole row, which is why COLUMNS is a constant
      // rather than something measured back out of the DOM.
      else if (e.key === 'ArrowDown') setActive((i) => Math.min(i + COLUMNS, last));
      else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - COLUMNS, 0));
      else {
        const item = items[active];
        if (item) surface.applyEmojiCommand(item.char);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [state, items, active, surface]);

  // Anchor below the caret like the sibling menus. The row count is passed so the
  // helper can decide whether the popover fits underneath.
  const { ref, pos } = useAnchoredRect(state?.rect ?? null, isOpen, rows.length, 'below');

  // Index of each entry in the flat order, so a row can tell which of its cells
  // is the active one without recomputing the walk per cell.
  let cursor = -1;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={ref}
          className="rich-slash-menu sk-emoji-menu"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          role="listbox"
          aria-label="Insert emoji"
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {!entries && <div className="rich-slash-empty">Loading emoji…</div>}
          {entries && items.length === 0 && (
            <div className="rich-slash-empty">No emoji for “{query}”</div>
          )}
          {rows.map((row, r) =>
            row.kind === 'header' ? (
              <div key={`h${r}`} className="sk-emoji-group">
                {row.name}
              </div>
            ) : (
              <div key={`r${r}`} className="sk-emoji-row">
                {row.items.map((item) => {
                  cursor += 1;
                  const isActive = cursor === active;
                  const index = cursor;
                  return (
                    <button
                      key={item.char}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      aria-label={item.label}
                      title={item.label}
                      className={`sk-emoji-cell${isActive ? ' active' : ''}`}
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(e: MouseEvent) => {
                        e.preventDefault();
                        surface.applyEmojiCommand(item.char);
                      }}
                    >
                      {item.char}
                    </button>
                  );
                })}
              </div>
            )
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
