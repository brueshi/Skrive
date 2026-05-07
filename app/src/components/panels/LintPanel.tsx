// Project-wide lint findings list. Phase 8.
//
// Mirrors BacklinksPanel chrome — same wrapper class, same close-on-
// outside-click and Escape behavior. Findings are read from the store
// (`lintReport`); the engine runs centrally on open / save / watcher
// events, not per-panel-mount.

import { useEffect, useMemo, useRef } from 'react';
import { useProjectStore } from '../../stores/project';
import type { LintFinding } from '@skrive/shared';
import { IconLintError } from '../icons/IconLintError';
import { IconLintWarn } from '../icons/IconLintWarn';

type GroupedFindings = Array<{
  path: string;
  rows: LintFinding[];
}>;

function groupByPath(findings: LintFinding[]): GroupedFindings {
  const byPath = new Map<string, LintFinding[]>();
  for (const finding of findings) {
    let bucket = byPath.get(finding.path);
    if (!bucket) {
      bucket = [];
      byPath.set(finding.path, bucket);
    }
    bucket.push(finding);
  }
  return [...byPath.entries()].map(([path, rows]) => ({ path, rows }));
}

export function LintPanel() {
  const open = useProjectStore((s) => s.lintPanelOpen);
  const setOpen = useProjectStore((s) => s.setLintPanelOpen);
  const report = useProjectStore((s) => s.lintReport);
  const openTab = useProjectStore((s) => s.openTab);

  const panelRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(
    () => (report ? groupByPath(report.findings) : []),
    [report]
  );

  const errorCount = useMemo(
    () =>
      report?.findings.filter((f) => f.severity === 'error').length ?? 0,
    [report]
  );
  const warnCount = useMemo(
    () => report?.findings.filter((f) => f.severity === 'warn').length ?? 0,
    [report]
  );

  // Click-outside + Escape dismissal — same shape as BacklinksPanel.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const root = panelRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      if (target && root.contains(target)) return;
      const hit = (target as Element | null)?.closest?.(
        '[data-panel-toggle="lint"]'
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

  function handleRowClick(path: string) {
    setOpen(false);
    void openTab(path);
  }

  const totalFindings = report?.findings.length ?? 0;

  return (
    <div
      className={`bl-panel-wrapper${open ? ' bl-panel-open' : ''}`}
      aria-hidden={!open}
    >
      <div
        ref={panelRef}
        className="bl-panel lint-panel"
        role="dialog"
        tabIndex={-1}
        aria-label="Lint findings"
      >
        <header className="bl-panel-header">
          <span className="bl-panel-title">Lint</span>
          <span className="lint-panel-summary">
            {errorCount > 0 && (
              <span className="lint-summary-pill lint-summary-error">
                {errorCount} error{errorCount === 1 ? '' : 's'}
              </span>
            )}
            {warnCount > 0 && (
              <span className="lint-summary-pill lint-summary-warn">
                {warnCount} warning{warnCount === 1 ? '' : 's'}
              </span>
            )}
          </span>
          <span className="bl-panel-count">{totalFindings}</span>
        </header>

        <div className="bl-panel-body">
          {totalFindings === 0 ? (
            <p className="bl-empty">No lint findings.</p>
          ) : (
            <ul className="lint-groups">
              {groups.map((group) => (
                <li key={group.path} className="lint-group">
                  <div className="lint-group-path" title={group.path}>
                    {group.path}
                  </div>
                  <ul className="bl-rows">
                    {group.rows.map((finding) => (
                      <li
                        key={`${finding.rule}:${finding.line}:${finding.column}`}
                        className="bl-row"
                      >
                        <button
                          type="button"
                          className="bl-row-button lint-row"
                          onClick={() => handleRowClick(finding.path)}
                          title={`${finding.path}:${finding.line}`}
                        >
                          <span
                            className={`lint-row-icon lint-row-icon-${finding.severity}`}
                            aria-hidden="true"
                          >
                            {finding.severity === 'error' ? (
                              <IconLintError size={16} />
                            ) : (
                              <IconLintWarn size={16} />
                            )}
                          </span>
                          <span className="lint-row-message">
                            {finding.message}
                          </span>
                          <span className="lint-row-meta">
                            <span className="lint-row-rule">
                              {finding.rule}
                            </span>
                            <span className="bl-row-line">
                              :{finding.line}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
