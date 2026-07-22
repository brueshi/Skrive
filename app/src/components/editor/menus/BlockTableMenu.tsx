// The per-row/column table menu for the bespoke surface (SKR-266 B2b). A chrome
// handle click opens it, anchored to the handle: the affordance grammar homes
// table structural editing in per-block chrome, and this is where mid-table
// insertion (insert around) and delete live, alongside the append rails and the
// ⌥⌘ keyboard chords. Column alignment joins it in B3.
//
// Surface-driven like the slash / tag popovers (onTableMenu is a single-subscriber
// callback), but a fixed command list rather than a live query: no filtering, just
// keyboard-navigable items. While open, a capture-phase keydown owns Escape / the
// arrows / Enter so the surface's own keydown never also fires; a pointer down
// outside, or a scroll (the anchor rides the content), dismisses it.

import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { BlockSurface, TableMenuState } from '../../../lib/blocksurface';
import { useAnchoredRect } from './useAnchoredRect';
import './menus.css';

type TableMenuItem = { label: string; run: () => void; danger?: boolean };

/** The commands for a given menu state — insert on either side of the slice, then
 *  delete it. Column and row differ only in wording and axis. Each command closes
 *  the menu; the insert ops land the caret in the new cell (which dissolves the
 *  selection), and delete routes through removeTable*At. */
function itemsFor(surface: BlockSurface, state: TableMenuState): TableMenuItem[] {
  const { tableId, index, kind } = state;
  const close = () => surface.closeTableMenu();
  if (kind === 'col') {
    return [
      { label: 'Insert column left', run: () => (surface.insertTableColumnAt(tableId, index), close()) },
      { label: 'Insert column right', run: () => (surface.insertTableColumnAt(tableId, index + 1), close()) },
      { label: 'Delete column', danger: true, run: () => (surface.removeTableColumnAt(tableId, index), close()) }
    ];
  }
  return [
    { label: 'Insert row above', run: () => (surface.insertTableRowAt(tableId, index), close()) },
    { label: 'Insert row below', run: () => (surface.insertTableRowAt(tableId, index + 1), close()) },
    { label: 'Delete row', danger: true, run: () => (surface.removeTableRowAt(tableId, index), close()) }
  ];
}

export function BlockTableMenu({ surface }: { surface: BlockSurface }) {
  const [state, setState] = useState<TableMenuState | null>(null);
  const [active, setActive] = useState(0);
  // Bumped each open so useAnchoredRect re-measures against the new handle rect.
  const [rev, setRev] = useState(0);
  const reduced = useReducedMotion();
  const isOpen = state != null;

  useEffect(() => {
    surface.onTableMenu((next) => {
      setState(next);
      setActive(0);
      setRev((r) => r + 1);
    });
    return () => surface.onTableMenu(null);
  }, [surface]);

  const items = useMemo(() => (state ? itemsFor(surface, state) : []), [surface, state]);

  // Keyboard: own Escape / arrows / Enter while open (capture phase, so the
  // surface's keydown — which would otherwise dissolve the selection on Escape —
  // never also fires).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        surface.closeTableMenu();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        items[active]?.run();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [isOpen, items, active, surface]);

  // Dismiss on a pointer down outside the menu, or on scroll (the anchor rides the
  // scroller's content, so a static viewport rect goes stale — close rather than
  // chase it).
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.sk-table-menu')) return;
      surface.closeTableMenu();
    };
    const onScroll = () => surface.closeTableMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [isOpen, surface]);

  const { ref, pos } = useAnchoredRect(state?.rect ?? null, isOpen, rev, 'below');

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={ref}
          className="rich-slash-menu sk-table-menu"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          role="menu"
          aria-label={state?.kind === 'col' ? 'Column actions' : 'Row actions'}
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`rich-slash-item${i === active ? ' active' : ''}${item.danger ? ' sk-table-menu-item--danger' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e: MouseEvent) => {
                e.preventDefault();
                item.run();
              }}
            >
              <span className="rich-slash-title">{item.label}</span>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
