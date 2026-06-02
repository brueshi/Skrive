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

  // Escape-to-close. Docked panels stay put on outside clicks so you can
  // keep editing alongside them; only Escape and the toggle dismiss.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // stopImmediatePropagation so a sibling panel's document-level
        // handler doesn't also fire — Escape dismisses one layer at a time.
        e.preventDefault();
        e.stopImmediatePropagation();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
      widthRem={26}
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
            <p className="bl-empty">
              Nothing links to this file yet — references with{' '}
              <code>[[wiki]]</code> or{' '}
              <code>[markdown](links)</code> will show up here.
            </p>
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
