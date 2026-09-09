// The table menu for the bespoke surface. Opened on demand for a cell rectangle:
// a right-click on a cell, or the keyboard menu key with the caret in one or a
// grid selection active (the menu then targets the selection's shape). The
// affordance grammar homes table structural editing in per-block chrome, and this
// is where mid-table insertion (insert around), column alignment, and delete
// live, alongside the append buttons and the ⌥⌘ keyboard chords. Never the side
// effect of a click: a handle click only selects.
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
import type { TableAlign } from '../../../lib/blockmodel';
import { useAnchoredRect } from './useAnchoredRect';
import './menus.css';

type TableMenuItem = { label: string; run: () => void; danger?: boolean; checked?: boolean };

/** The alignment the covered columns share, or null when they differ or are all
 *  default. Read from the live document so the alignment group can mark the
 *  active option. */
function currentAlign(surface: BlockSurface, tableId: string, from: number, to: number): TableAlign {
  const table = surface.getDocument().blocks.find((b) => b.id === tableId);
  if (table?.type !== 'table') return null;
  const first = table.align[from] ?? null;
  for (let c = from + 1; c <= to; c++) if ((table.align[c] ?? null) !== first) return null;
  return first;
}

/** The command groups for a rectangle's menu, rendered with a separator between
 *  groups: insert-around (above the first row, below the last, left of the first
 *  column, right of the last), the covered columns' alignment (left / center /
 *  right, the shared value checked and a re-pick toggling back to default), then
 *  delete rows and delete columns, plural when the rectangle spans more than one.
 *  Each command closes the menu; insert lands the caret in the new cell, delete
 *  routes through removeTable*At, and alignment re-serializes the delimiter row. */
function groupsFor(surface: BlockSurface, state: TableMenuState): TableMenuItem[][] {
  const { tableId, cells } = state;
  const { minRow, maxRow, minCol, maxCol } = cells;
  const close = () => surface.closeTableMenu();
  const active = currentAlign(surface, tableId, minCol, maxCol);
  const alignItem = (label: string, value: Exclude<TableAlign, null>): TableMenuItem => ({
    label,
    checked: active === value,
    // Re-picking the shared alignment clears the columns back to the default.
    run: () => {
      for (let c = minCol; c <= maxCol; c++) surface.setColumnAlignment(tableId, c, active === value ? null : value);
      close();
    }
  });
  const rows = maxRow - minRow + 1;
  const cols = maxCol - minCol + 1;
  return [
    [
      { label: 'Insert row above', run: () => (surface.insertTableRowAt(tableId, minRow, minCol), close()) },
      { label: 'Insert row below', run: () => (surface.insertTableRowAt(tableId, maxRow + 1, minCol), close()) },
      { label: 'Insert column left', run: () => (surface.insertTableColumnAt(tableId, minCol, minRow), close()) },
      { label: 'Insert column right', run: () => (surface.insertTableColumnAt(tableId, maxCol + 1, minRow), close()) }
    ],
    [alignItem('Align left', 'left'), alignItem('Align center', 'center'), alignItem('Align right', 'right')],
    [
      {
        label: rows > 1 ? 'Delete rows' : 'Delete row',
        danger: true,
        run: () => (surface.removeTableRowsAt(tableId, minRow, maxRow), close())
      },
      {
        label: cols > 1 ? 'Delete columns' : 'Delete column',
        danger: true,
        run: () => (surface.removeTableColumnsAt(tableId, minCol, maxCol), close())
      }
    ]
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

  const groups = useMemo(() => (state ? groupsFor(surface, state) : []), [surface, state]);
  // Flat list for keyboard navigation; the grouping only drives separators.
  const items = useMemo(() => groups.flat(), [groups]);

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
          aria-label="Table actions"
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {groups.map((group, g) => (
            <div key={g} className="sk-table-menu-group" role="group">
              {g > 0 && <div className="sk-table-menu-sep" role="separator" />}
              {group.map((item) => {
                const i = items.indexOf(item);
                return (
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
                    {item.checked && (
                      <span className="sk-table-menu-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
