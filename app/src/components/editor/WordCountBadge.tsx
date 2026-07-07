// The floating document counter (SKR-53): a small chip in the editor pane's
// bottom-left corner showing one figure at a time — words, reading time, or
// characters — with a side chevron opening a menu to switch. The chosen
// metric persists as a preference. While a range is selected the chip shows
// the selection in the active metric instead.
//
// Anchored-floater tier chrome (the selection bubble's language: page fill,
// hairline, float lift, md radius), tabular numerals so the live figures tick
// without jitter. The chevron is the only interactive part; the label passes
// clicks through so the chip steals nothing from the prose behind it.
//
// The mounting surface supplies the document counts (each editor has a
// coalesced live channel); `useSelectionCounts` watches `selectionchange`
// rAF-coalesced — reading the textarea's selection range when a textarea
// inside the scope has focus (the Markdown source view; `window.getSelection`
// doesn't expose textarea text), and the DOM selection otherwise (the block
// surface and rendered preview).

import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { WordCountMetric } from '@skrive/shared';
import {
  computeReadingTime,
  computeWordCount
} from '../../lib/frontmatter';
import type { LiveCounts } from '../../lib/wordcount/live';
import { usePreferencesStore } from '../../stores/preferences';
import { IconChevronDown } from './menus/toolbar-icons';
import { Tooltip } from '../ui/Tooltip';
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

const METRICS: ReadonlyArray<{ id: WordCountMetric; label: string }> = [
  { id: 'words', label: 'Words' },
  { id: 'time', label: 'Reading time' },
  { id: 'chars', label: 'Characters' }
];

function metricLabel(
  metric: WordCountMetric,
  counts: LiveCounts,
  selected: boolean
): string {
  const suffix = selected ? ' selected' : '';
  switch (metric) {
    case 'time':
      return `${fmt.format(computeReadingTime(counts.words))} min read${suffix}`;
    case 'chars':
      return `${fmt.format(counts.chars)} chars${suffix}`;
    default:
      return `${fmt.format(counts.words)} words${suffix}`;
  }
}

export function WordCountBadge({
  counts,
  scopeRef
}: {
  counts: LiveCounts;
  /** The pane the selection must live in to count as "selected here". */
  scopeRef: React.RefObject<HTMLElement | null>;
}) {
  const metric = usePreferencesStore((s) => s.wordCountMetric);
  const setMetric = usePreferencesStore((s) => s.setWordCountMetric);
  const selection = useSelectionCounts(scopeRef);
  const shown = selection ?? counts;

  return (
    <div className="word-count-badge">
      <span className="word-count-label" aria-live="off">
        {metricLabel(metric, shown, selection !== null)}
      </span>
      <DropdownMenu.Root>
        <Tooltip label="Count metric">
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="word-count-chevron"
              aria-label="Choose count metric"
            >
              <IconChevronDown size={12} />
            </button>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="ctx-menu word-count-menu"
            align="start"
            side="top"
            sideOffset={6}
          >
            {METRICS.map((m) => (
              <DropdownMenu.Item
                key={m.id}
                className="ctx-item"
                onSelect={() => setMetric(m.id)}
              >
                <span className="ctx-label">{m.label}</span>
                {metric === m.id && <span className="ctx-shortcut">✓</span>}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
