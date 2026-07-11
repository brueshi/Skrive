// Project-wide full-text search.
//
// ⌘F opens it (overrides the in-document find — Skrive's find is
// project-wide; in-doc navigation is by scroll). Debounced 150ms query,
// monotonic search token discards out-of-order responses, hits grouped
// by file. Enter / click jumps to the hit via openDocAtLine.
//
// Two-pane layout (Skrive 1.0): the grouped result list on the left, a
// context preview of the highlighted match on the right — see the match
// in its surrounding lines before jumping. The preview reads the file
// body once per file and caches it for the session.
//
// Built on Radix Dialog so focus trap, ESC, scroll lock, and portal
// placement come from the primitive.

import * as Dialog from '@radix-ui/react-dialog';
import { DialogShell } from '../ui/Dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '@skrive/shared';
import { logProjectError, useProjectStore } from '../../stores/project';
import { notify } from '../../lib/notify';
import { projectModel } from '../../lib/project-model/client';

const DEBOUNCE_MS = 150;
/** Lines of context shown on each side of the match in the preview. */
const PREVIEW_CONTEXT = 4;

type Props = {
  open: boolean;
  onClose: () => void;
};

type Group = { path: string; items: SearchHit[] };

type PreviewLine = {
  num: number;
  text: string;
  isMatch: boolean;
  /** Match span within `text`, when isMatch. */
  matchStart?: number;
  matchEnd?: number;
};

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

/** Build the preview window around a hit from the full file body. */
function buildPreview(body: string, hit: SearchHit): PreviewLine[] {
  const lines = body.split('\n');
  const matchIdx = hit.line - 1; // SearchHit.line is 1-indexed.
  const from = Math.max(0, matchIdx - PREVIEW_CONTEXT);
  const to = Math.min(lines.length - 1, matchIdx + PREVIEW_CONTEXT);
  const out: PreviewLine[] = [];
  for (let i = from; i <= to; i++) {
    const text = lines[i] ?? '';
    if (i === matchIdx) {
      const matchStart = Math.max(0, Math.min(text.length, hit.column));
      out.push({
        num: i + 1,
        text,
        isMatch: true,
        matchStart,
        matchEnd: Math.min(text.length, matchStart + hit.matchLength)
      });
    } else {
      out.push({ num: i + 1, text, isMatch: false });
    }
  }
  return out;
}

const RESULTS_LISTBOX_ID = 'skrive-search-results';
const HIT_OPTION_ID = (idx: number) => `skrive-search-hit-${idx}`;

export function SearchModal({ open, onClose }: Props) {
  const openDocAtLine = useProjectStore((s) => s.openDocAtLine);
  const manifestRoot = useProjectStore((s) => s.manifest?.root ?? null);

  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preview, setPreview] = useState<PreviewLine[] | null>(null);

  const tokenRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // File bodies cached for the open session so arrowing through hits in
  // the same file doesn't re-read it from disk.
  const fileCache = useRef<Map<string, string>>(new Map());

  const groups = useMemo(() => groupByPath(hits), [hits]);
  const selectedHit = hits[selectedIndex] ?? null;

  // Reset on close so the next open starts clean.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setHits([]);
    setError(null);
    setLoading(false);
    setSelectedIndex(0);
    setPreview(null);
    fileCache.current.clear();
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
      const client = projectModel();
      if (!client) {
        setLoading(false);
        return;
      }
      client
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

  // Build the preview for the highlighted hit, reading (and caching) the
  // file body when needed.
  useEffect(() => {
    if (!open || !selectedHit || !manifestRoot) {
      setPreview(null);
      return;
    }
    const hit = selectedHit;
    const cached = fileCache.current.get(hit.path);
    if (cached !== undefined) {
      setPreview(buildPreview(cached, hit));
      return;
    }
    let cancelled = false;
    void window.skrive.fs
      .readFile(manifestRoot, hit.path)
      .then((fc) => {
        if (cancelled) return;
        fileCache.current.set(hit.path, fc.body);
        setPreview(buildPreview(fc.body, hit));
      })
      .catch((err) => {
        if (cancelled) return;
        logProjectError('search:readFile', err);
        setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedHit, manifestRoot]);

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
      queueMicrotask(() => scrollSelectedIntoView(next));
      return next;
    });
  }

  async function openSelected() {
    const hit = hits[selectedIndex];
    if (!hit) return;
    onClose();
    try {
      await openDocAtLine(hit.path, hit.line, hit.column, hit.matchLength);
    } catch (err) {
      logProjectError('openDocAtLine', err);
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
    <DialogShell
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      variant="palette"
      className="search-palette"
      aria-label="Search project"
    >
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
              role="combobox"
              aria-controls={RESULTS_LISTBOX_ID}
              aria-expanded={hits.length > 0}
              aria-activedescendant={
                hits.length > 0 ? HIT_OPTION_ID(selectedIndex) : undefined
              }
              aria-autocomplete="list"
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

          <div className="search-body">
            <div className="search-left">
              <div className="search-status">
                {loading && <span>Searching…</span>}
                {!loading && error && (
                  <span className="search-err">{error}</span>
                )}
                {!loading && !error && query.trim().length === 0 && (
                  <span>Type to search file contents.</span>
                )}
                {!loading &&
                  !error &&
                  query.trim().length > 0 &&
                  hits.length === 0 && <span>No matches.</span>}
                {!loading && !error && hits.length > 0 && (
                  <span>
                    {hits.length} {hits.length === 1 ? 'match' : 'matches'} in{' '}
                    {groups.length} {groups.length === 1 ? 'file' : 'files'}
                  </span>
                )}
              </div>

              <div
                ref={listRef}
                className="search-results"
                role="listbox"
                id={RESULTS_LISTBOX_ID}
                aria-label="Search results"
              >
                {groups.map((group, gi) => (
                  <div key={group.path} className="search-group">
                    <div className="search-group-header">
                      <span className="search-group-path">{group.path}</span>
                      <span className="search-group-count">
                        {group.items.length}
                      </span>
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
                          id={HIT_OPTION_ID(idx)}
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
            </div>

            <div className="search-preview" aria-hidden>
              {selectedHit && preview ? (
                <>
                  <div className="search-preview-path">{selectedHit.path}</div>
                  <div className="search-preview-code">
                    {preview.map((line) => (
                      <div
                        key={line.num}
                        className={`search-preview-line${
                          line.isMatch ? ' is-match' : ''
                        }`}
                      >
                        <span className="search-preview-gutter">{line.num}</span>
                        <span className="search-preview-text">
                          {line.isMatch ? (
                            <>
                              {line.text.slice(0, line.matchStart)}
                              <mark>
                                {line.text.slice(line.matchStart, line.matchEnd)}
                              </mark>
                              {line.text.slice(line.matchEnd)}
                            </>
                          ) : (
                            line.text
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="search-preview-empty">
                  {hits.length > 0
                    ? 'Select a match to preview it in context.'
                    : 'Matches preview here.'}
                </div>
              )}
            </div>
          </div>
    </DialogShell>
  );
}
