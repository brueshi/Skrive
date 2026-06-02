// The active document's link neighborhood, in two directions:
//   - "Links to"   — outgoing edges (this doc references other files),
//                    from the link graph's getOutgoing.
//   - "Linked from" — incoming edges (other files reference this doc),
//                    from getBacklinks.
//
// Both are grouped by the other file, each group expandable to its
// individual references (line + snippet). A folder-path pill on each
// group keeps same-named files in different folders distinguishable.
//
// Navigation follows "go to the reference, or follow the link":
//   - a "Linked from" reference opens its source file at that line (the
//     backlink text lives there);
//   - a "Links to" reference opens the resolved target file (follow the
//     link); for a dead or wiki target there's nothing to open, so it
//     jumps to the link's own line in this document instead.

import { useEffect, useMemo, useRef, useState } from 'react';
import { selectActiveTab, useProjectStore } from '../../stores/project';
import type { Backlink, OutgoingLink } from '@skrive/shared';
import { PanelShell } from './PanelShell';

type RefItem = {
  /** 0-indexed line of the reference in its host file. */
  line: number;
  column: number;
  snippet: string;
};

type FileGroup = {
  /** Group key: the other file's path, or the wiki name. */
  key: string;
  folder: string;
  name: string;
  refs: RefItem[];
  /** Outbound only: does the target resolve to a project file? */
  resolved: boolean;
  isWiki: boolean;
};

function splitPath(p: string): { folder: string; name: string } {
  const i = p.lastIndexOf('/');
  return i === -1
    ? { folder: '', name: p }
    : { folder: p.slice(0, i), name: p.slice(i + 1) };
}

function lineSnippet(body: string, line0: number): string {
  const line = body.split('\n')[line0] ?? '';
  return line.trim().slice(0, 200);
}

/** Group inbound backlinks by their source file, preserving the
 *  snippet the graph already computed. */
function groupInbound(links: Backlink[]): FileGroup[] {
  const byFile = new Map<string, FileGroup>();
  for (const link of links) {
    let group = byFile.get(link.source);
    if (!group) {
      const { folder, name } = splitPath(link.source);
      group = {
        key: link.source,
        folder,
        name,
        refs: [],
        resolved: true,
        isWiki: false
      };
      byFile.set(link.source, group);
    }
    group.refs.push({
      line: link.line,
      column: link.column,
      snippet: link.snippet
    });
  }
  return [...byFile.values()];
}

/** Group outbound edges by their target, deriving each reference's
 *  snippet from the active document body (the link lives here). */
function groupOutbound(links: OutgoingLink[], body: string): FileGroup[] {
  const byTarget = new Map<string, FileGroup>();
  for (const link of links) {
    let group = byTarget.get(link.target);
    if (!group) {
      const isWiki = link.targetKind === 'wiki';
      const { folder, name } = isWiki
        ? { folder: '', name: link.target }
        : splitPath(link.target);
      group = {
        key: link.target,
        folder,
        name,
        refs: [],
        resolved: link.resolved,
        isWiki
      };
      byTarget.set(link.target, group);
    }
    group.refs.push({
      line: link.line,
      column: link.column,
      snippet: lineSnippet(body, link.line)
    });
  }
  return [...byTarget.values()];
}

export function BacklinksPanel() {
  const open = useProjectStore((s) => s.backlinksPanelOpen);
  const setOpen = useProjectStore((s) => s.setBacklinksPanelOpen);
  const activeTab = useProjectStore(selectActiveTab);
  const openTabAtLine = useProjectStore((s) => s.openTabAtLine);

  const [inbound, setInbound] = useState<Backlink[]>([]);
  const [outbound, setOutbound] = useState<OutgoingLink[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement | null>(null);

  const activePath = activeTab?.path ?? '';
  const body = activeTab?.body ?? '';

  // Fetch both directions on open + active-tab change.
  useEffect(() => {
    if (!open || !activeTab) {
      setInbound([]);
      setOutbound([]);
      return;
    }
    const path = activeTab.path;
    let cancelled = false;
    void Promise.all([
      window.skrive.linkGraph.getBacklinks(path),
      window.skrive.linkGraph.getOutgoing(path)
    ]).then(([back, out]) => {
      if (cancelled) return;
      setInbound(back);
      setOutbound(out);
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeTab?.path]);

  // Escape-to-close. Docked panels stay put on outside clicks.
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

  const outboundGroups = useMemo(
    () => groupOutbound(outbound, body),
    [outbound, body]
  );
  const inboundGroups = useMemo(() => groupInbound(inbound), [inbound]);

  function toggle(groupKey: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  function openOutboundRef(group: FileGroup, ref: RefItem) {
    setOpen(false);
    if (group.resolved && !group.isWiki) {
      // Follow the link to its target file.
      void openTabAtLine(group.key, 1, 0, 0);
    } else {
      // Dead or wiki target — jump to the link in this document instead.
      void openTabAtLine(activePath, ref.line + 1, ref.column, 0);
    }
  }

  function openInboundRef(group: FileGroup, ref: RefItem) {
    setOpen(false);
    void openTabAtLine(group.key, ref.line + 1, ref.column, 0);
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
        <span className="bl-panel-title">Links</span>
        <span className="bl-panel-target" title={activePath}>
          {activePath}
        </span>
      </header>

      <div className="bl-panel-body">
        <BacklinkSection
          label="Links to"
          groups={outboundGroups}
          collapsed={collapsed}
          onToggle={toggle}
          onRefClick={openOutboundRef}
          showResolved
          emptyHint={
            <>
              This file doesn't link anywhere yet — references with{' '}
              <code>[[wiki]]</code> or <code>[markdown](links)</code> will show
              up here.
            </>
          }
        />
        <BacklinkSection
          label="Linked from"
          groups={inboundGroups}
          collapsed={collapsed}
          onToggle={toggle}
          onRefClick={openInboundRef}
          emptyHint={<>Nothing links to this file yet.</>}
        />
      </div>
    </PanelShell>
  );
}

function BacklinkSection({
  label,
  groups,
  collapsed,
  onToggle,
  onRefClick,
  showResolved = false,
  emptyHint
}: {
  label: string;
  groups: FileGroup[];
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onRefClick: (group: FileGroup, ref: RefItem) => void;
  showResolved?: boolean;
  emptyHint: React.ReactNode;
}) {
  const refCount = groups.reduce((n, g) => n + g.refs.length, 0);
  return (
    <section className="bl-section">
      <div className="bl-section-head">
        <span className="bl-section-label">{label}</span>
        <span className="bl-section-count">{refCount}</span>
      </div>
      {groups.length === 0 ? (
        <p className="bl-empty">{emptyHint}</p>
      ) : (
        <ul className="bl-groups">
          {groups.map((group) => {
            const groupKey = `${label}:${group.key}`;
            const badges = (
              <>
                {group.folder && (
                  <span className="bl-folder-pill" title={group.folder}>
                    {group.folder}
                  </span>
                )}
                {showResolved && !group.resolved && (
                  <span className="bl-dead-badge" title="Target not found">
                    dead
                  </span>
                )}
                {group.isWiki && (
                  <span className="bl-wiki-badge" title="Wiki link">
                    wiki
                  </span>
                )}
              </>
            );

            // A file referenced once collapses to a single combined row —
            // a caret + count + nested row would be three affordances for
            // one link. Only files with multiple references get the
            // expandable header.
            if (group.refs.length === 1) {
              const ref = group.refs[0]!;
              return (
                <li key={groupKey} className="bl-group">
                  <button
                    type="button"
                    className="bl-single"
                    onClick={() => onRefClick(group, ref)}
                    title={`${group.name}:${ref.line + 1}`}
                  >
                    <span className="bl-single-head">
                      <span className="bl-group-name">{group.name}</span>
                      {badges}
                      <span className="bl-ref-line">{ref.line + 1}</span>
                    </span>
                    <span className="bl-ref-snippet">{ref.snippet}</span>
                  </button>
                </li>
              );
            }

            const isCollapsed = collapsed.has(groupKey);
            return (
              <li key={groupKey} className="bl-group">
                <button
                  type="button"
                  className="bl-group-head"
                  aria-expanded={!isCollapsed}
                  onClick={() => onToggle(groupKey)}
                >
                  <svg
                    className={`bl-caret${isCollapsed ? '' : ' open'}`}
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M4.5 3L8 6L4.5 9"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="bl-group-name">{group.name}</span>
                  {badges}
                  <span className="bl-group-count">{group.refs.length}</span>
                </button>
                {!isCollapsed && (
                  <ul className="bl-refs">
                    {group.refs.map((ref) => (
                      <li key={`${ref.line}:${ref.column}`} className="bl-ref">
                        <button
                          type="button"
                          className="bl-ref-button"
                          onClick={() => onRefClick(group, ref)}
                          title={`${group.name}:${ref.line + 1}`}
                        >
                          <span className="bl-ref-line">{ref.line + 1}</span>
                          <span className="bl-ref-snippet">{ref.snippet}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
