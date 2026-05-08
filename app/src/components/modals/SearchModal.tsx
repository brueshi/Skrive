// Project-wide full-text search modal.
//
// ⌘F opens it (overrides the in-document find — Skrive's find is
// project-wide; in-doc navigation is by scroll). Debounced 150ms
// query, monotonic search token discards out-of-order responses,
// hits are grouped by file with the path-sorted order from shell.
// Enter / click jumps to the hit via openTabAtLine.
//
// Built on Radix Dialog so focus trap, ESC, scroll lock, and portal
// placement come from the primitive. The visual is a slimmer-than-
// modal-dialog backdrop + a wider palette to fit code-style snippets.

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '@skrive/shared';
import { logProjectError, useProjectStore } from '../../stores/project';
import { notify } from '../../lib/notify';

const DEBOUNCE_MS = 150;

type Props = {
  open: boolean;
  onClose: () => void;
};

type Group = { path: string; items: SearchHit[] };

function groupByPath(hits: SearchHit[]): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const hit of hits) {
    if (!current || current.path !== hit.path) {
      current = { path: hit.path, items: [hit] };
      groups.push(current);
    } else {
      current.items.push(hit);
    }
  }
  return groups;
}

function flatIndexFor(groups: Group[], gi: number, hi: number): number {
  let n = hi;
  for (let i = 0; i < gi; i++) n += groups[i]?.items.length ?? 0;
  return n;
}

function splitSnippet(hit: SearchHit): {
  before: string;
  matched: string;
  after: string;
} {
  const start = Math.max(0, hit.column);
  const end = Math.min(hit.snippet.length, start + hit.matchLength);
  return {
    before: hit.snippet.slice(0, start),
    matched: hit.snippet.slice(start, end),
    after: hit.snippet.slice(end)
  };
}

export function SearchModal({ open, onClose }: Props) {
  const openTabAtLine = useProjectStore((s) => s.openTabAtLine);

  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Token guards against out-of-order resolves: if the user types fast,
  // an earlier invoke may resolve after a later one. Discard any result
  // whose token doesn't match the latest issued.
  const tokenRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(() => groupByPath(hits), [hits]);

  // Reset state every time the modal closes so the next open starts
  // clean. Done on the close transition rather than on open so the
  // closing animation doesn't show empty state for a frame.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setHits([]);
    setError(null);
    setLoading(false);
    setSelectedIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (trimmed.length === 0) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      tokenRef.current += 1;
      const issued = tokenRef.current;
      window.skrive.search
        .searchProject(trimmed, { caseSensitive })
        .then((result) => {
          if (issued !== tokenRef.current) return;
          setHits(result);
          setSelectedIndex(0);
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          if (issued !== tokenRef.current) return;
          logProjectError('search:searchProject', err);
          setHits([]);
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, caseSensitive, open]);

  function scrollSelectedIntoView(idx: number) {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${idx}"]`
    );
    el?.scrollIntoView({ block: 'nearest' });
  }

  function moveSelection(delta: number) {
    if (hits.length === 0) return;
    setSelectedIndex((prev) => {
      const next = (prev + delta + hits.length) % hits.length;
      // Schedule scroll after the state commit lands.
      queueMicrotask(() => scrollSelectedIntoView(next));
      return next;
    });
  }

  async function openSelected() {
    const hit = hits[selectedIndex];
    if (!hit) return;
    onClose();
    try {
      await openTabAtLine(hit.path, hit.line, hit.column, hit.matchLength);
    } catch (err) {
      logProjectError('openTabAtLine', err);
      notify.error(`Couldn't open ${hit.path}`, err);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void openSelected();
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="search-backdrop" />
        <Dialog.Content className="search-palette" aria-label="Search project">
          <Dialog.Title className="visually-hidden">Search project</Dialog.Title>
          <div className="search-query-row">
            <input
              type="text"
              className="search-query"
              placeholder="Search project…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKey}
              autoFocus
              spellCheck={false}
            />
            <label className="search-case-toggle" title="Match case">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              <span>Aa</span>
            </label>
          </div>

          <div className="search-status">
            {loading && <span>Searching…</span>}
            {!loading && error && <span className="search-err">{error}</span>}
            {!loading && !error && query.trim().length === 0 && (
              <span>Type to search file contents.</span>
            )}
            {!loading && !error && query.trim().length > 0 && hits.length === 0 && (
              <span>No matches.</span>
            )}
            {!loading && !error && hits.length > 0 && (
              <span>
                {hits.length} {hits.length === 1 ? 'match' : 'matches'} in{' '}
                {groups.length} {groups.length === 1 ? 'file' : 'files'}
              </span>
            )}
          </div>

          <div ref={listRef} className="search-results" role="listbox">
            {groups.map((group, gi) => (
              <div key={group.path} className="search-group">
                <div className="search-group-header">
                  <span className="search-group-path">{group.path}</span>
                  <span className="search-group-count">{group.items.length}</span>
                </div>
                {group.items.map((hit, hi) => {
                  const idx = flatIndexFor(groups, gi, hi);
                  const parts = splitSnippet(hit);
                  const selected = idx === selectedIndex;
                  return (
                    <button
                      key={`${hit.line}:${hit.column}`}
                      type="button"
                      className={`search-hit${selected ? ' selected' : ''}`}
                      data-index={idx}
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={() => {
                        setSelectedIndex(idx);
                        void openSelected();
                      }}
                    >
                      <span className="search-line-no">{hit.line}</span>
                      <span className="search-snippet">
                        <span className="search-ctx">{parts.before}</span>
                        <mark>{parts.matched}</mark>
                        <span className="search-ctx">{parts.after}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
