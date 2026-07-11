// The active document's link neighborhood, matched to the paper mock:
//   - "Linked from" — incoming references (getBacklinks), grouped by
//     source file. A source with several references is an expandable
//     group; a single reference collapses to one row. Each reference
//     shows its quoted line and line number, with an L-connector tying
//     it to its source.
//   - "Links to" — outgoing links (getOutgoing), one row per target
//     file with a chain glyph, clicking through to the target.
//
// Header carries the title, a count of incoming references, and a close
// control. Navigation follows the reference: a "Linked from" reference
// opens its source at that line; a "Links to" target opens the target
// (or, for a dead / wiki target, jumps to the link in this document).

import { useEffect, useMemo, useRef, useState } from 'react';
import { IconButton } from '../ui/IconButton';
import { Tooltip } from '../ui/Tooltip';
import { selectLiveDoc, useProjectStore } from '../../stores/project';
import type { Backlink, OutgoingLink } from '@skrive/shared';
import { PanelShell } from './PanelShell';
import { projectModel } from '../../lib/project-model/client';

type RefItem = { line: number; column: number; snippet: string };

type SourceGroup = {
  key: string;
  folder: string;
  name: string;
  refs: RefItem[];
};

type Target = {
  key: string;
  folder: string;
  name: string;
  resolved: boolean;
  isWiki: boolean;
  firstRef: RefItem;
  count: number;
};

function splitPath(p: string): { folder: string; name: string } {
  const i = p.lastIndexOf('/');
  return i === -1
    ? { folder: '', name: p }
    : { folder: p.slice(0, i), name: p.slice(i + 1) };
}

function groupSources(links: Backlink[]): SourceGroup[] {
  const byFile = new Map<string, SourceGroup>();
  for (const link of links) {
    let group = byFile.get(link.source);
    if (!group) {
      const { folder, name } = splitPath(link.source);
      group = { key: link.source, folder, name, refs: [] };
      byFile.set(link.source, group);
    }
    group.refs.push({ line: link.line, column: link.column, snippet: link.snippet });
  }
  return [...byFile.values()];
}

function groupTargets(links: OutgoingLink[]): Target[] {
  const byTarget = new Map<string, Target>();
  for (const link of links) {
    const existing = byTarget.get(link.target);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const isWiki = link.targetKind === 'wiki';
    const { folder, name } = isWiki
      ? { folder: '', name: link.target }
      : splitPath(link.target);
    byTarget.set(link.target, {
      key: link.target,
      folder,
      name,
      resolved: link.resolved,
      isWiki,
      firstRef: { line: link.line, column: link.column, snippet: '' },
      count: 1
    });
  }
  return [...byTarget.values()];
}

/** Chevron — points right collapsed, down expanded. */
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      className={`bl-caret${open ? ' open' : ''}`}
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
    >
      <path
        d="M4.5 3L7.5 6L4.5 9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderPill({ folder }: { folder: string }) {
  if (!folder) return null;
  return (
    <span className="bl-folder-pill" title={folder}>
      {folder}
    </span>
  );
}

export function BacklinksPanel() {
  const open = useProjectStore((s) => s.backlinksPanelOpen);
  const setOpen = useProjectStore((s) => s.setBacklinksPanelOpen);
  const activeTab = useProjectStore(selectLiveDoc);
  const openDocAtLine = useProjectStore((s) => s.openDocAtLine);

  const [inbound, setInbound] = useState<Backlink[]>([]);
  const [outbound, setOutbound] = useState<OutgoingLink[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement | null>(null);

  const activePath = activeTab?.path ?? '';

  useEffect(() => {
    if (!open || !activeTab) {
      setInbound([]);
      setOutbound([]);
      return;
    }
    const path = activeTab.path;
    let cancelled = false;
    const client = projectModel();
    if (!client) return;
    void Promise.all([
      client.getBacklinks(path),
      client.getOutgoing(path)
    ]).then(([back, out]) => {
      if (cancelled) return;
      setInbound(back);
      setOutbound(out);
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeTab?.path]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const sources = useMemo(() => groupSources(inbound), [inbound]);
  const targets = useMemo(() => groupTargets(outbound), [outbound]);

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function openSource(group: SourceGroup, ref: RefItem) {
    setOpen(false);
    void openDocAtLine(group.key, ref.line + 1, ref.column, 0);
  }

  function openTarget(target: Target) {
    setOpen(false);
    if (target.resolved && !target.isWiki) {
      void openDocAtLine(target.key, 1, 0, 0);
    } else {
      void openDocAtLine(activePath, target.firstRef.line + 1, target.firstRef.column, 0);
    }
  }

  return (
    <PanelShell
      open={open}
      ariaLabel="Backlinks"
      panelRef={panelRef}
      className="bl-panel"
      widthRem={26}
    >
      <header className="bl-panel-header">
        <div className="bl-title-group">
          <span className="bl-title">Backlinks</span>
          <span className="bl-count-badge">{inbound.length}</span>
        </div>
        <Tooltip label="Close backlinks">
          <IconButton
            aria-label="Close backlinks"
            onClick={() => setOpen(false)}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path
                d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>
        </Tooltip>
      </header>

      <div className="bl-panel-body">
        <section className="bl-section">
          <h3 className="bl-section-cap">Linked from</h3>
          {sources.length === 0 ? (
            <p className="bl-empty">Nothing links to this file yet.</p>
          ) : (
            sources.map((group) => {
              const isCollapsed = collapsed.has(group.key);
              const single = group.refs.length === 1;
              if (single) {
                const ref = group.refs[0]!;
                return (
                  <div key={group.key} className="bl-source-single">
                    <button
                      type="button"
                      className="bl-source-head"
                      onClick={() => openSource(group, ref)}
                      title={`${group.name}:${ref.line + 1}`}
                    >
                      <span className="bl-source-name">{group.name}</span>
                      <FolderPill folder={group.folder} />
                      <span className="bl-ref-line">line {ref.line + 1}</span>
                    </button>
                    <p className="bl-ref-snippet bl-ref-snippet--inset">
                      {`“${ref.snippet}”`}
                    </p>
                  </div>
                );
              }
              return (
                <div key={group.key} className="bl-source">
                  <button
                    type="button"
                    className="bl-source-head bl-source-head--group"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(group.key)}
                  >
                    <Caret open={!isCollapsed} />
                    <span className="bl-source-name">{group.name}</span>
                    <FolderPill folder={group.folder} />
                    <span className="bl-group-count">{group.refs.length}</span>
                  </button>
                  {!isCollapsed &&
                    group.refs.map((ref) => (
                      <button
                        key={`${ref.line}:${ref.column}`}
                        type="button"
                        className="bl-ref"
                        onClick={() => openSource(group, ref)}
                        title={`${group.name}:${ref.line + 1}`}
                      >
                        <span className="bl-ref-connector" aria-hidden>
                          <svg width="16" height="40" viewBox="0 0 16 40" fill="none">
                            <path d="M5 0V20H13" stroke="currentColor" strokeWidth="1.2" />
                          </svg>
                        </span>
                        <span className="bl-ref-body">
                          <span className="bl-ref-snippet">{`“${ref.snippet}”`}</span>
                          <span className="bl-ref-line">line {ref.line + 1}</span>
                        </span>
                      </button>
                    ))}
                </div>
              );
            })
          )}
        </section>

        <section className="bl-section bl-section--links-to">
          <h3 className="bl-section-cap">Links to</h3>
          {targets.length === 0 ? (
            <p className="bl-empty">
              This file doesn't link anywhere yet.
            </p>
          ) : (
            targets.map((target) => (
              <button
                key={target.key}
                type="button"
                className={`bl-target${target.resolved ? '' : ' is-dead'}`}
                onClick={() => openTarget(target)}
                title={target.key}
              >
                <span className="bl-link-icon" aria-hidden>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M6 10L10 6M6.5 4.5L7.5 3.5C8.6 2.4 10.3 2.4 11.4 3.5C12.5 4.6 12.5 6.3 11.4 7.4L10.4 8.4M9.5 11.5L8.5 12.5C7.4 13.6 5.7 13.6 4.6 12.5C3.5 11.4 3.5 9.7 4.6 8.6L5.6 7.6"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                <span className="bl-target-name">{target.name}</span>
                {target.isWiki ? (
                  <span className="bl-tag">wiki</span>
                ) : !target.resolved ? (
                  <span className="bl-tag bl-tag--dead">dead</span>
                ) : (
                  <FolderPill folder={target.folder} />
                )}
                {target.count > 1 && (
                  <span className="bl-group-count">{target.count}</span>
                )}
              </button>
            ))
          )}
        </section>
      </div>
    </PanelShell>
  );
}
