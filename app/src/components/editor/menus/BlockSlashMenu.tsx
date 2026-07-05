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

import { Fragment, useEffect, useMemo, useState, type ComponentType, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { BlockSurface, BlockTypeSpec, SlashMenuState } from '../../../lib/blocksurface';
import { platformShortcut } from '../../../lib/commands/shortcut-display';
import { useAnchoredRect } from './useAnchoredRect';
import {
  IconParagraph,
  IconHeading1,
  IconHeading2,
  IconHeading3,
  IconQuote,
  IconBulletList,
  IconOrderedList,
  IconCodeBlock,
  IconTable,
  IconDivider
} from './toolbar-icons';
import './menus.css';

type IconC = ComponentType<{ size?: number; className?: string }>;
type Item = {
  title: string;
  keywords: string;
  spec: BlockTypeSpec;
  Icon: IconC;
  /** Visual group; a hairline separates consecutive groups in the menu. */
  group: 'text' | 'list' | 'block';
  /** macOS-symbol shortcut hint, rendered via platformShortcut. Only present
   *  where the surface actually binds one — an aspirational hint would lie. */
  shortcut?: string;
};

const ITEMS: Item[] = [
  { title: 'Text', keywords: 'text paragraph body plain', spec: { kind: 'paragraph' }, Icon: IconParagraph, group: 'text' },
  { title: 'Heading 1', keywords: 'h1 heading title', spec: { kind: 'heading', level: 1 }, Icon: IconHeading1, group: 'text' },
  { title: 'Heading 2', keywords: 'h2 heading subtitle', spec: { kind: 'heading', level: 2 }, Icon: IconHeading2, group: 'text' },
  { title: 'Heading 3', keywords: 'h3 heading', spec: { kind: 'heading', level: 3 }, Icon: IconHeading3, group: 'text' },
  { title: 'Bullet list', keywords: 'bullet list unordered ul', spec: { kind: 'bullet_list' }, Icon: IconBulletList, group: 'list', shortcut: '⌘⇧8' },
  { title: 'Numbered list', keywords: 'numbered ordered list ol', spec: { kind: 'ordered_list' }, Icon: IconOrderedList, group: 'list', shortcut: '⌘⇧7' },
  { title: 'Quote', keywords: 'quote blockquote', spec: { kind: 'blockquote' }, Icon: IconQuote, group: 'block' },
  { title: 'Code', keywords: 'code monospace pre fenced', spec: { kind: 'code' }, Icon: IconCodeBlock, group: 'block' },
  { title: 'Table', keywords: 'table grid rows columns', spec: { kind: 'table' }, Icon: IconTable, group: 'block' },
  { title: 'Divider', keywords: 'divider rule separator hr line', spec: { kind: 'divider' }, Icon: IconDivider, group: 'block' }
];

function filterItems(query: string): Item[] {
  const q = query.trim().toLowerCase();
  if (!q) return ITEMS;
  return ITEMS.filter((it) => it.title.toLowerCase().includes(q) || it.keywords.includes(q));
}

export function BlockSlashMenu({ surface }: { surface: BlockSurface }) {
  const [state, setState] = useState<SlashMenuState | null>(null);
  const [active, setActive] = useState(0);
  const reduced = useReducedMotion();
  const isOpen = state != null;

  useEffect(() => {
    surface.onSlashMenu(setState);
    return () => surface.onSlashMenu(null);
  }, [surface]);

  const items = useMemo(() => filterItems(state?.query ?? ''), [state?.query]);
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
            return (
              <Fragment key={item.title}>
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
                  {item.shortcut && (
                    <span className="rich-slash-shortcut" aria-hidden="true">
                      {platformShortcut(item.shortcut)}
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
