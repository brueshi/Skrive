// The insert (slash) menu for the bespoke surface, at visual parity with the Rich
// one (shared rich-slash CSS, custom icons, framer-motion). Unlike the toolbar /
// bubble / link editor, the slash menu is NOT unified behind MenuController: the
// two editors detect the `/` trigger and drive keyboard navigation in
// fundamentally different ways (a PM plugin reading doc positions vs. this
// capture-phase keydown over the bespoke surface's observer), and merging those
// drivers buys no visual parity. So this keeps the bespoke driver and shares only
// the presentation; full unification is deferred to the Stage-6 affordance registry.
//
// While open, a capture-phase keydown owns Escape unconditionally, and Arrow/
// Enter only while there is at least one match — calling BOTH preventDefault AND
// stopPropagation so the surface's own keydown (Enter = split) never also fires.
// A zero-match query (SKR-172 / F68) renders a quiet "No matches" row instead of
// nothing, and lets Enter/arrows fall through to normal editing rather than
// preventDefault-ing into `items[undefined]` no-ops; the session stays open so
// deleting back to a matching query brings the list back live.

import { Fragment, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { BlockSurface, SlashMenuState } from '../../../lib/blocksurface';
import { platformShortcut } from '../../../lib/commands/shortcut-display';
import { useAnchoredRect } from './useAnchoredRect';
import { catalogHint, filterCatalog } from './insert-catalog';
import './menus.css';

export function BlockSlashMenu({ surface }: { surface: BlockSurface }) {
  const [state, setState] = useState<SlashMenuState | null>(null);
  const [active, setActive] = useState(0);
  const reduced = useReducedMotion();
  const isOpen = state != null;

  useEffect(() => {
    surface.onSlashMenu(setState);
    return () => surface.onSlashMenu(null);
  }, [surface]);

  // `when` is decided identically across renderers (grammar §3). A slash session
  // is bound to one block, so its table-context can't flip mid-session — read it
  // from the surface's live selection when filtering.
  const inTable = state ? (surface.getSelectionInfo()?.inTable ?? false) : false;
  // An inline session (mid-text `/` at a word boundary) offers only the catalog's
  // Inline group — those entries splice at the caret, which is the only insert
  // that makes sense mid-sentence. Block conversions stay empty-line-only.
  const items = useMemo(() => {
    const all = filterCatalog(state?.query ?? '', { inTable });
    return state?.kind === 'inline' ? all.filter((e) => e.group === 'inline') : all;
  }, [state?.query, state?.kind, inTable]);
  const visible = isOpen;

  // A session opening (not a query narrowing within one that's already open)
  // always starts the highlight back at the first item (SKR-172 papercut) — a
  // reopen must not carry over where the previous session left off.
  useEffect(() => {
    if (isOpen) setActive(0);
  }, [isOpen]);

  // Keep the active index in range as the filter narrows.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape always closes, even with zero matches — it is the guaranteed way
      // out of the session regardless of what the query narrowed to.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        surface.closeSlash();
        return;
      }
      // Zero matches (SKR-172 / F68): nothing renders to navigate, so Arrow/
      // Enter are left alone to fall through to normal editing (Enter splits
      // the block; refreshSlash then closes the session once the `/` run is
      // gone or the caret left the block). The session itself stays open so
      // deleting back to a matching query re-shows the list live.
      if (items.length === 0) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
      // Own these keys fully while open: stopPropagation so the surface's own
      // capture-phase keydown (Enter = split) never also fires on this event.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, items.length - 1));
      else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
      else if (e.key === 'Enter') {
        const item = items[active];
        if (item) surface.applySlashCommand(item.spec);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [state, items, active, surface]);

  // The trigger rect anchors the menu below the `/`; re-measure as the query grows.
  const { ref, pos } = useAnchoredRect(state?.rect ?? null, visible, items.length, 'below');

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={ref}
          className="rich-slash-menu"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          role="listbox"
          aria-label="Insert block"
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.length === 0 && <div className="rich-slash-empty">No matches</div>}
          {items.map((item, i) => {
            const isActive = i === active;
            const prev = items[i - 1];
            const hint = catalogHint(item);
            return (
              <Fragment key={item.id}>
                {prev && prev.group !== item.group && (
                  <div className="rich-slash-sep" aria-hidden="true" />
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className={`rich-slash-item${isActive ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e: MouseEvent) => {
                    e.preventDefault();
                    surface.applySlashCommand(item.spec);
                  }}
                >
                  <span className="rich-slash-icon">
                    <item.Icon size={18} />
                  </span>
                  <span className="rich-slash-title">{item.title}</span>
                  {hint && (
                    <span className="rich-slash-shortcut" aria-hidden="true">
                      {hint.kind === 'shortcut' ? platformShortcut(hint.text) : hint.text}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
