// The in-document find/replace bar: ambient anchored-floater chrome (the
// WordCountBadge language — page fill, hairline, float lift), pinned to the top of
// the editor pane, keyboard-first. It owns the generic find loop — the ordered hit
// list, the active index, cycling, the count — and delegates the medium-specific
// work (search, highlight, replace, save/restore caret) to a FindTarget, so the
// same bar backs both the block surface and the textarea editors.
//
// Focus stays in the query field while cycling: the active match is revealed and
// highlighted through the overlay, never by moving the caret, so Enter/Shift+Enter
// keep the keyboard here. The caret is saved on open and restored on Esc.

import { useEffect, useRef, useState } from 'react';
import { useFindStore } from '../../../stores/find';
import { IconButton } from '../../ui/IconButton';
import { IconChevronDown } from '../menus/toolbar-icons';
import type { FindTarget, FindHit } from './FindTarget';
import './FindBar.css';

export function FindBar({ target }: { target: FindTarget }): React.ReactElement | null {
  const open = useFindStore((s) => s.open);
  const replaceVisible = useFindStore((s) => s.replaceVisible);
  const query = useFindStore((s) => s.query);
  const replacement = useFindStore((s) => s.replacement);
  const flags = useFindStore((s) => s.flags);
  const focusNonce = useFindStore((s) => s.focusNonce);
  const setQuery = useFindStore((s) => s.setQuery);
  const setReplacement = useFindStore((s) => s.setReplacement);
  const toggleFlag = useFindStore((s) => s.toggleFlag);
  const close = useFindStore((s) => s.close);

  const [hits, setHits] = useState<FindHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Save the caret on open; clear highlights and restore it on close / unmount.
  useEffect(() => {
    if (!open) return;
    target.saveSelection();
    return () => {
      target.clearHighlight();
      target.restoreSelection();
    };
  }, [open, target]);

  // Focus + select the query field on open and on every re-open (⌘F while open).
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, focusNonce]);

  // Recompute matches when the query or flags change, debounced so a big document
  // isn't rescanned on every keystroke. Resets to the first match and repaints.
  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      const found = target.search(query, flags);
      setHits(found);
      setActiveIndex(0);
      target.highlight(found, 0);
    }, 90);
    return () => window.clearTimeout(handle);
  }, [open, query, flags, target]);

  if (!open) return null;

  const cycle = (delta: number): void => {
    if (hits.length === 0) return;
    const next = (activeIndex + delta + hits.length) % hits.length;
    setActiveIndex(next);
    target.highlight(hits, next);
  };

  // After an edit the offsets shift, so re-search from the live document and clamp
  // the active index into the new (smaller) hit list.
  const refreshAfterEdit = (): void => {
    const found = target.search(query, flags);
    setHits(found);
    const next = found.length === 0 ? 0 : Math.min(activeIndex, found.length - 1);
    setActiveIndex(next);
    target.highlight(found, next);
  };

  const onReplace = (): void => {
    if (hits.length === 0) return;
    target.replace(hits[activeIndex]!, replacement);
    refreshAfterEdit();
  };

  const onReplaceAll = (): void => {
    if (hits.length === 0) return;
    target.replaceAll(hits, replacement);
    refreshAfterEdit();
  };

  const onQueryKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      cycle(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const onReplaceKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) onReplaceAll();
      else onReplace();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const count = hits.length > 0 ? `${activeIndex + 1} of ${hits.length}` : query.length > 0 ? 'No results' : '';
  const noHits = hits.length === 0;

  return (
    <div className="find-bar" role="search" aria-label="Find in document">
      <div className="find-row">
        <IconButton
          size="sm"
          aria-label={replaceVisible ? 'Hide replace' : 'Show replace'}
          aria-expanded={replaceVisible}
          className="find-disclosure"
          onClick={() => useFindStore.setState((s) => ({ replaceVisible: !s.replaceVisible }))}
        >
          <IconChevronDown />
        </IconButton>
        <input
          ref={inputRef}
          className="find-input"
          placeholder="Find"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onQueryKeyDown}
          spellCheck={false}
          autoCorrect="off"
          aria-label="Find"
        />
        <div className="find-flags">
          <FlagButton label="Match case" on={flags.caseSensitive} onClick={() => toggleFlag('caseSensitive')}>
            Aa
          </FlagButton>
          <FlagButton label="Whole word" on={flags.wholeWord} onClick={() => toggleFlag('wholeWord')}>
            <span className="find-flag-word">ab</span>
          </FlagButton>
          <FlagButton label="Regular expression" on={flags.regex} onClick={() => toggleFlag('regex')}>
            .*
          </FlagButton>
        </div>
        <span className="find-count" aria-live="polite">
          {count}
        </span>
        <IconButton size="sm" aria-label="Previous match" onClick={() => cycle(-1)} disabled={noHits}>
          <ChevronUp />
        </IconButton>
        <IconButton size="sm" aria-label="Next match" onClick={() => cycle(1)} disabled={noHits}>
          <ChevronDown />
        </IconButton>
        <IconButton size="sm" aria-label="Close find" onClick={() => close()}>
          <CloseGlyph />
        </IconButton>
      </div>
      {replaceVisible && (
        <div className="find-row">
          <span className="find-disclosure-spacer" aria-hidden="true" />
          <input
            className="find-input"
            placeholder="Replace"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={onReplaceKeyDown}
            spellCheck={false}
            autoCorrect="off"
            aria-label="Replace"
          />
          <button type="button" className="find-action" onClick={onReplace} disabled={noHits}>
            Replace
          </button>
          <button type="button" className="find-action" onClick={onReplaceAll} disabled={noHits}>
            All
          </button>
        </div>
      )}
    </div>
  );
}

function FlagButton({
  label,
  on,
  onClick,
  children
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <IconButton size="sm" className="find-flag" aria-label={label} aria-pressed={on} title={label} onClick={onClick}>
      <span className="find-flag-glyph">{children}</span>
    </IconButton>
  );
}

function ChevronUp(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDown(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseGlyph(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
