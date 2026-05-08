// Floating backlinks list for the active tab. "What links to this
// file?" — one row per inbound reference, showing source path, line
// number, and a snippet of the line. Clicking a row opens that source
// (line-jump is a phase-7 follow-up; today the cursor lands at the top).
//
// Phase 6 ports the v0.1 BacklinksPanel.svelte. Mutual-exclusion with
// other top-right panels (frontmatter, dictionary) reapplies once those
// land in phases 7 + 9.

import { useEffect, useRef, useState } from 'react';
import {
  selectActiveTab,
  useProjectStore
} from '../../stores/project';
import type { Backlink } from '@skrive/shared';
import { PanelShell } from './PanelShell';

export function BacklinksPanel() {
  const open = useProjectStore((s) => s.backlinksPanelOpen);
  const setOpen = useProjectStore((s) => s.setBacklinksPanelOpen);
  const activeTab = useProjectStore(selectActiveTab);
  const openTabAtLine = useProjectStore((s) => s.openTabAtLine);

  const [rows, setRows] = useState<Backlink[]>([]);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Fetch on open + on active-tab change. Closing leaves stale rows
  // around briefly during the close animation; that's fine.
  useEffect(() => {
    if (!open || !activeTab) {
      setRows([]);
      return;
    }
    const path = activeTab.path;
    let cancelled = false;
    void window.skrive.linkGraph.getBacklinks(path).then((next) => {
      if (cancelled) return;
      setRows(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeTab?.path]);

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
        '[data-panel-toggle="backlinks"]'
      );
      if (hit) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    }
    // Defer to the next tick so the click that opened the panel
    // doesn't immediately close it.
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onMouseDown);
    }, 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  function handleRowClick(row: Backlink) {
    setOpen(false);
    // Backlink.line is 0-indexed; openTabAtLine expects 1-indexed
    // (CodeMirror's line.number convention).
    void openTabAtLine(row.source, row.line + 1, row.column, 0);
  }

  const activePath = activeTab?.path ?? '';

  return (
    <PanelShell
      open={open}
      ariaLabel="Backlinks"
      panelRef={panelRef}
      className="bl-panel"
      width="26rem"
    >
      <header className="bl-panel-header">
          <span className="bl-panel-title">Backlinks</span>
          <span className="bl-panel-target" title={activePath}>
            {activePath}
          </span>
          <span className="bl-panel-count">{rows.length}</span>
        </header>

        <div className="bl-panel-body">
          {rows.length === 0 ? (
            <p className="bl-empty">Nothing links to this file yet.</p>
          ) : (
            <ul className="bl-rows">
              {rows.map((row) => (
                <li
                  key={`${row.source}:${row.line}:${row.column}`}
                  className="bl-row"
                >
                  <button
                    type="button"
                    className="bl-row-button"
                    onClick={() => handleRowClick(row)}
                    title={`${row.source}:${row.line + 1}`}
                  >
                    <span className="bl-row-meta">
                      <span className="bl-row-path">{row.source}</span>
                      <span className="bl-row-line">:{row.line + 1}</span>
                    </span>
                    <span className="bl-row-snippet">{row.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
    </PanelShell>
  );
}
