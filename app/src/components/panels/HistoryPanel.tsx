// Floating version-history list for the active tab. One row per git
// commit or checkpoint, newest-first. Same visual language as the
// other top-right panels (backlinks, frontmatter); shares the
// last-opened-wins mutex with them.
//
// Click semantics (per docs/3.3-diff-ui-design.md):
//   - Single click = diff that version against the current file, and
//     stash the row's id as the pair-compare baseline.
//   - Shift-click while a baseline is stashed = pair-diff that
//     baseline against the shift-clicked row.
//
// Diff entry is disabled while the active tab is in split mode (the
// two-pane surface DiffView needs is already in use); the panel
// shows a notice and renders rows inert.

import { useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '@skrive/shared';
import {
  selectActiveTab,
  useProjectStore
} from '../../stores/project';

function entryId(entry: HistoryEntry): string {
  return entry.source === 'git' ? entry.sha : entry.id;
}

function entryKey(entry: HistoryEntry): string {
  return `${entry.source}:${entryId(entry)}`;
}

function entryPrimary(entry: HistoryEntry): string {
  if (entry.source === 'git') return entry.subject || '(no subject)';
  if (entry.name) return entry.name;
  if (entry.kind === 'manual') return '(pinned)';
  return 'Autosave';
}

function entryMeta(entry: HistoryEntry): string {
  if (entry.source === 'git') return entry.shortSha;
  return entry.kind === 'manual' ? 'manual' : 'auto';
}

function isoTooltip(entry: HistoryEntry): string {
  const iso = new Date(entry.timestampMs).toISOString();
  if (entry.source === 'git') {
    const author = entry.authorName ? ` — ${entry.authorName}` : '';
    return `${iso}${author}\n${entry.sha}`;
  }
  return iso;
}

function relativeTime(tsMs: number, nowMs: number): string {
  const delta = nowMs - tsMs;
  if (delta < 0) return 'just now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} wk${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  const years = Math.floor(days / 365);
  return `${years} yr${years === 1 ? '' : 's'} ago`;
}

export function HistoryPanel() {
  const open = useProjectStore((s) => s.historyPanelOpen);
  const setOpen = useProjectStore((s) => s.setHistoryPanelOpen);
  const closePanel = useProjectStore((s) => s.closeHistoryPanel);
  const activeTab = useProjectStore(selectActiveTab);
  const rows = useProjectStore((s) => s.historyOfActive);
  const mode = useProjectStore((s) => s.historyMode);
  const baseId = useProjectStore((s) => s.historyPairBaseId);
  const setBaseId = useProjectStore((s) => s.setHistoryPairBaseId);
  const refreshHistory = useProjectStore((s) => s.refreshHistory);
  const openDiff = useProjectStore((s) => s.openDiffForEntry);

  const splitBlocksDiff = activeTab?.layoutMode === 'split';
  const activePath = activeTab?.path ?? '';

  const panelRef = useRef<HTMLDivElement | null>(null);

  // Re-fetch on active-tab change while open.
  useEffect(() => {
    if (!open) return;
    void refreshHistory();
  }, [open, activeTab?.path, refreshHistory]);

  // "Now" sample. Re-samples once a minute so "N min ago" rows
  // self-update without a panel close/reopen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [open]);

  // Click-outside dismissal. Skip the toggle button itself so it can
  // close-via-click without racing the outside-click handler.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const root = panelRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      if (target && root.contains(target)) return;
      const hit = (target as Element | null)?.closest?.(
        '[data-panel-toggle="history"]'
      );
      if (hit) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onMouseDown);
    }, 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen, closePanel]);

  function handleRowClick(entry: HistoryEntry, event: React.MouseEvent) {
    if (splitBlocksDiff) return;
    const id = entryId(entry);
    if (event.shiftKey && baseId && baseId !== id) {
      const baseline = rows.find((r) => entryId(r) === baseId) ?? null;
      void openDiff(entry, baseline);
      return;
    }
    // Single click: stash anchor + enter diff vs current. Stashing
    // before the call means a follow-up shift-click still has the
    // right baseline even if the entry flow clears state.
    setBaseId(id);
    void openDiff(entry, null);
  }

  return (
    <div
      className={`hi-panel-wrapper${open ? ' hi-panel-open' : ''}`}
      aria-hidden={!open}
    >
      <div
        ref={panelRef}
        className="hi-panel"
        role="dialog"
        tabIndex={-1}
        aria-label="Version history"
      >
        <header className="hi-panel-header">
          <span className="hi-panel-title">History</span>
          <span className="hi-panel-target" title={activePath}>
            {activePath}
          </span>
          {mode && (
            <span
              className="hi-panel-mode"
              title={
                mode === 'git'
                  ? 'Backed by git'
                  : 'Backed by Skrive checkpoints'
              }
            >
              {mode === 'git' ? 'git' : 'checkpoints'}
            </span>
          )}
          <span className="hi-panel-count">{rows.length}</span>
        </header>

        <div className="hi-panel-body">
          {splitBlocksDiff && (
            <p className="hi-notice">
              Switch to raw or preview to compare versions — split mode
              uses the two-pane surface diff needs.
            </p>
          )}
          {!mode ? (
            <p className="hi-empty">Open a project to view its history.</p>
          ) : rows.length === 0 ? (
            <p className="hi-empty">
              {mode === 'git'
                ? 'No commits touch this file yet.'
                : 'No checkpoints yet — Skrive writes one every few minutes of editing.'}
            </p>
          ) : (
            <ul className="hi-rows">
              {rows.map((row) => {
                const id = entryId(row);
                const pinned = id === baseId;
                return (
                  <li key={entryKey(row)} className="hi-row">
                    <button
                      type="button"
                      className={`hi-row-button${pinned ? ' hi-row-pinned' : ''}`}
                      disabled={splitBlocksDiff}
                      onClick={(e) => handleRowClick(row, e)}
                      title={isoTooltip(row)}
                    >
                      <span className="hi-row-line-1">
                        <span className="hi-row-primary">
                          {entryPrimary(row)}
                        </span>
                        {pinned && (
                          <span
                            className="hi-row-anchor"
                            aria-label="Baseline for shift-click compare"
                          >
                            ⇌
                          </span>
                        )}
                      </span>
                      <span className="hi-row-line-2">
                        <span className="hi-row-meta">{entryMeta(row)}</span>
                        <span className="hi-row-time">
                          {relativeTime(row.timestampMs, now)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
