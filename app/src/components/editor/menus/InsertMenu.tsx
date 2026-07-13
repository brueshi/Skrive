// The toolbar Insert dropdown (SKR-243, chrome-affordance-grammar §3): the
// discoverable half of the Insert catalog. A vertical menu scales to thirty
// entries where the old horizontal button strip died at ten. It renders the same
// INSERT_CATALOG the slash menu and palette read, through the same filterCatalog
// matcher — parity is a rule, so the matcher is shared too.
//
// Anatomy (grammar §3 + the SKR-207 menu language): a fuzzy-search input pinned
// at top, rows of icon · title · right-hint (the input rule where one exists, else
// the shortcut), full keyboard, and the shipped toast's soft lift. Built as a
// body-portalled panel anchored under the trigger — the slash menu's proven
// pattern — rather than a Radix popover: no new dependency, and activation stays
// on `click` (never pointerup), which the WKWebView shell needs and the Chromium
// harness is blind to. Block transforms act on the surface's saved selection, so
// the input taking focus never loses the target block.

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { MenuController } from './controller';
import { catalogHint, dispatchInsert, filterCatalog, type InsertEntry } from './insert-catalog';
import { platformShortcut } from '../../../lib/commands/shortcut-display';
import { useAnchoredRect } from './useAnchoredRect';
import { IconChevronDown } from './toolbar-icons';
import './menus.css';

export function InsertMenu({
  controller,
  disabled = false
}: {
  controller: MenuController;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reduced = useReducedMotion();

  // A table cell disables the trigger (SKR-219), so the menu never opens there —
  // inTable is false whenever filtering runs, but read it honestly all the same.
  const inTable = controller.getSnapshot().selection.inTable;
  const items = useMemo(() => filterCatalog(query, { inTable }), [query, inTable]);

  // Reset on close (not open) so the next open starts blank without a flash of
  // stale results during the open animation — the palette's pattern.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  // Keep the active row in range as the filter narrows.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  // Focus the search input when the panel opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Anchor under the trigger; re-measure live on scroll/resize (the button is
  // always mounted, so its rect is the source of truth) and as the list resizes.
  // liveRect MUST be a stable reference: useAnchoredRect rebuilds its reposition
  // from it and calls setPos, so a fresh arrow each render would loop forever.
  const liveRect = useCallback(
    () => triggerRef.current?.getBoundingClientRect() ?? null,
    []
  );
  const { ref: panelRef, pos } = useAnchoredRect(null, open, items.length, 'below', liveRect);

  // Dismiss on a pointer press outside the panel and trigger. Bound while open;
  // the opening click has already fired before this attaches.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, panelRef]);

  function close(): void {
    setOpen(false);
    controller.focusEditor();
  }

  function pick(entry: InsertEntry): void {
    dispatchInsert(controller, entry.spec);
    close();
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>): void {
    // Escape owns its event: stopPropagation so it closes the menu rather than
    // also reaching a window-level Esc handler (panel dismissal, etc.).
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (item) pick(item);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`rich-toolbar-blocktype rich-toolbar-insert${open ? ' active' : ''}`}
        title="Insert"
        aria-label="Insert"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        // Keep the editor selection from collapsing when the trigger is pressed
        // (matches the other toolbar controls); the input is focused explicitly
        // once the panel mounts.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <span>Insert</span>
        <IconChevronDown size={14} />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panelRef}
              className="rich-insert-menu"
              style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
              initial={reduced ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
            >
              <input
                ref={inputRef}
                className="rich-insert-input"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onInputKeyDown}
                placeholder="Search blocks…"
                aria-label="Search insertable blocks"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="rich-insert-list" role="listbox" aria-label="Insertable blocks">
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
                        // preventDefault keeps focus on the input; click still
                        // fires and dispatches the insert.
                        onMouseDown={(e: MouseEvent) => e.preventDefault()}
                        onClick={() => pick(item)}
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
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
