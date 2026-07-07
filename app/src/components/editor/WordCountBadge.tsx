// The quiet document counter (SKR-53): a compact muted readout pinned to the
// editor pane's bottom-left corner — words, characters, and reading time for
// the document, switching to selection counts while a range is selected.
// Ambient chrome like the outline rail: no border, no pill, non-interactive
// (toggled from Settings), tabular numerals so the live figures tick without
// jitter.
//
// Purely presentational plus one shared hook: the mounting surface supplies
// the document counts (each editor already has a coalesced live channel), and
// `useSelectionCounts` watches `selectionchange` rAF-coalesced — reading the
// textarea's selection range when a textarea inside the scope has focus (the
// Markdown source view; `window.getSelection` doesn't expose textarea text),
// and the DOM selection otherwise (the block surface and rendered preview).

import { useEffect, useRef, useState } from 'react';
import {
  computeReadingTime,
  computeWordCount
} from '../../lib/frontmatter';
import type { LiveCounts } from '../../lib/wordcount/live';
import './WordCountBadge.css';

export function useSelectionCounts(
  scopeRef: React.RefObject<HTMLElement | null>
): LiveCounts | null {
  const [counts, setCounts] = useState<LiveCounts | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const read = () => {
      rafRef.current = null;
      const scope = scopeRef.current;
      if (!scope) return;

      let text = '';
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && scope.contains(active)) {
        const { selectionStart, selectionEnd, value } = active;
        if (selectionStart !== selectionEnd) {
          text = value.slice(selectionStart ?? 0, selectionEnd ?? 0);
        }
      } else {
        const sel = window.getSelection();
        if (
          sel &&
          !sel.isCollapsed &&
          sel.anchorNode &&
          scope.contains(sel.anchorNode)
        ) {
          text = sel.toString();
        }
      }

      const next = text
        ? { words: computeWordCount(text), chars: text.length }
        : null;
      setCounts((prev) => {
        if (prev === next) return prev;
        if (
          prev &&
          next &&
          prev.words === next.words &&
          prev.chars === next.chars
        ) {
          return prev;
        }
        return next;
      });
    };

    const onSelectionChange = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(read);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [scopeRef]);

  return counts;
}

const fmt = new Intl.NumberFormat();

export function WordCountBadge({
  counts,
  scopeRef
}: {
  counts: LiveCounts;
  /** The pane the selection must live in to count as "selected here". */
  scopeRef: React.RefObject<HTMLElement | null>;
}) {
  const selection = useSelectionCounts(scopeRef);
  const shown = selection ?? counts;

  const parts = [`${fmt.format(shown.words)} words`, `${fmt.format(shown.chars)} chars`];
  if (selection) {
    parts.push('selected');
  } else if (shown.words > 0) {
    parts.push(`${fmt.format(computeReadingTime(shown.words))} min`);
  }

  return (
    <div className="word-count-badge" aria-live="off">
      {parts.join(' · ')}
    </div>
  );
}
