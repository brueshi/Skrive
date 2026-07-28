// The spelling correction menu: what a right-click on a squiggle opens.
//
// It is contextual chrome, not a new home for commands — it appears only over a
// misspelling, and a right-click anywhere else in the document passes straight
// through to the platform's own menu (the editor gates that; see BlockEditor).
//
// Three actions, in the order a writer reaches for them: take a suggestion, keep
// the word for good (Skrive's personal dictionary, editable in Settings), or
// keep it for now (ignored until the app restarts). Suggestions are fetched when
// the menu opens rather than kept for every misspelling — the oracle is only
// asked about a word the writer has actually questioned.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { BlockSurface } from '../../../lib/blocksurface';
import type { SpellcheckHandle } from '../../../lib/spellcheck/checker';
import { usePreferencesStore } from '../../../stores/preferences';
import './menus.css';

/** The squiggle a right-click landed on, and where the pointer was. */
export type SpellMenuTarget = {
  blockId: string;
  start: number;
  end: number;
  word: string;
  x: number;
  y: number;
};

/** How many of the oracle's candidates to show. Past a handful the list stops
 *  being a decision and starts being a search. */
const MAX_SUGGESTIONS = 6;

const MARGIN = 8;

export function SpellMenu({
  surface,
  spellcheck,
  target,
  onClose
}: {
  surface: BlockSurface;
  spellcheck: SpellcheckHandle;
  target: SpellMenuTarget | null;
  onClose: () => void;
}): React.ReactElement | null {
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();
  const addDictionaryWord = usePreferencesStore((s) => s.addDictionaryWord);
  const isOpen = target != null;

  // Ask about this word only, and only now. A menu closed before the answer
  // lands simply drops it.
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setSuggestions(null);
    void spellcheck.suggest(target.word).then((words) => {
      if (!cancelled) setSuggestions(words.slice(0, MAX_SUGGESTIONS));
    });
    return () => {
      cancelled = true;
    };
  }, [target, spellcheck]);

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: PointerEvent): void => {
      const node = e.target as Node | null;
      if (node && menuRef.current && !menuRef.current.contains(node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      surface.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [isOpen, onClose, surface]);

  if (!target) return null;

  // Anchored at the pointer, the way a context menu is expected to be, nudged
  // back inside the window when the click was near an edge.
  const width = menuRef.current?.offsetWidth ?? 0;
  const height = menuRef.current?.offsetHeight ?? 0;
  const left = Math.max(MARGIN, Math.min(target.x, window.innerWidth - width - MARGIN));
  const top = Math.max(MARGIN, Math.min(target.y, window.innerHeight - height - MARGIN));

  const correct = (replacement: string): void => {
    // The same primitive find/replace commits through: one undo step, model
    // first, caret left after the correction.
    surface.replaceMatch(target.blockId, target.start, target.end, replacement);
    onClose();
  };

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={menuRef}
          className="rich-slash-menu spell-menu"
          style={{ top, left }}
          role="menu"
          aria-label={`Spelling suggestions for ${target.word}`}
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
        >
          {suggestions === null ? (
            <div className="rich-slash-empty">Checking…</div>
          ) : suggestions.length === 0 ? (
            <div className="rich-slash-empty">No suggestions</div>
          ) : (
            suggestions.map((word) => (
              <button
                key={word}
                type="button"
                role="menuitem"
                className="rich-slash-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  correct(word);
                }}
              >
                <span className="rich-slash-title">{word}</span>
              </button>
            ))
          )}
          <div className="rich-slash-sep" />
          <button
            type="button"
            role="menuitem"
            className="rich-slash-item"
            onMouseDown={(e) => {
              e.preventDefault();
              addDictionaryWord(target.word);
              onClose();
            }}
          >
            <span className="rich-slash-title">Add to dictionary</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="rich-slash-item"
            onMouseDown={(e) => {
              e.preventDefault();
              void spellcheck.ignore(target.word);
              onClose();
            }}
          >
            <span className="rich-slash-title">Ignore</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
