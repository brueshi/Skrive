// The code-block language picker (SKR-262 / SKR-3). A per-block corner control per
// the affordance grammar (never a toolbar button): a code block's hover-revealed
// corner button opens this anchored, searchable list of languages, and choosing one
// sets the block's language — which drives syntax highlighting and the `.md` fence
// info string.
//
// Unlike the slash/tag menus it is click-triggered, so it owns its own filter input
// rather than reading a query the surface types into the document. It closes on
// Escape, an outside pointer-down, or a commit; the surface emits the open state and
// performs the commit (setCodeLanguage), keeping the model the single writer.

import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { BlockSurface, CodeLangMenuState } from '../../../lib/blocksurface';
import { LANGUAGE_CHOICES, resolveLanguage, type LanguageChoice } from '../../../lib/blocksurface/highlight/languages';
import { fuzzyMatch } from './insert-catalog';
import { useAnchoredRect } from './useAnchoredRect';
import './menus.css';

export function CodeLangMenu({ surface }: { surface: BlockSurface }) {
  const [state, setState] = useState<CodeLangMenuState | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();
  const isOpen = state != null;

  useEffect(() => {
    surface.onCodeLangMenu(setState);
    return () => surface.onCodeLangMenu(null);
  }, [surface]);

  // The block's current language, canonicalized, so the matching row reads as
  // selected even when the block stored an alias (`js` -> `javascript`).
  const currentValue = state ? resolveLanguage(state.current) ?? state.current.trim() : '';

  const items = useMemo<LanguageChoice[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...LANGUAGE_CHOICES];
    return LANGUAGE_CHOICES.filter((c) => fuzzyMatch(q, c.label.toLowerCase()) || fuzzyMatch(q, c.value));
  }, [query]);

  // Fresh open: clear the filter, focus the input, and start the highlight on the
  // current language (or the top when it isn't in the list).
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    const idx = LANGUAGE_CHOICES.findIndex((c) => c.value === currentValue);
    setActive(idx < 0 ? 0 : idx);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [isOpen, currentValue]);

  // Keep the highlight in range as the filtered list shrinks.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  // Keep the highlighted row visible as the arrows walk a long list (and when the
  // picker opens on a language far down). `nearest` never scrolls when already in view.
  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current?.querySelector<HTMLElement>('.rich-slash-item.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, isOpen]);

  const commit = (choice: LanguageChoice | undefined): void => {
    if (!state || !choice) return;
    surface.setCodeLanguage(state.blockId, choice.value);
  };

  // Close on any pointer-down outside the menu (the surface owns the null emit).
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && menuRef.current && !menuRef.current.contains(target)) surface.closeCodeLangMenu();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [isOpen, surface]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        surface.closeCodeLangMenu();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
      if (e.key !== 'Enter' && items.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, items.length - 1));
      else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
      else commit(items[active]);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [isOpen, items, active, surface]);

  const { ref, pos } = useAnchoredRect(state?.rect ?? null, isOpen, items.length, 'below');
  const setRefs = (el: HTMLDivElement | null): void => {
    ref.current = el;
    menuRef.current = el;
  };

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={setRefs}
          className="rich-slash-menu code-lang-menu"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          role="dialog"
          aria-label="Code block language"
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
        >
          <input
            ref={inputRef}
            className="code-lang-search"
            type="text"
            placeholder="Language…"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="code-lang-list" role="listbox" aria-label="Languages" ref={listRef}>
            {items.length === 0 && <div className="rich-slash-empty">No matching language</div>}
            {items.map((item, i) => {
              const isActive = i === active;
              const isCurrent = item.value === currentValue;
              return (
                <Fragment key={item.value || 'plain'}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={`rich-slash-item${isActive ? ' active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e: MouseEvent) => {
                      e.preventDefault();
                      commit(item);
                    }}
                  >
                    <span className="rich-slash-title">{item.label}</span>
                    {isCurrent && (
                      <span className="code-lang-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </button>
                  {/* Set the "none" choice apart from the real languages. */}
                  {item.value === '' && i < items.length - 1 && <div className="rich-slash-sep" />}
                </Fragment>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
