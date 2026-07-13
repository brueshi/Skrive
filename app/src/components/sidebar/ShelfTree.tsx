// The All list's folder shelf-tree (SKR-245, "treatment D"). The alternative
// to the flat list: top-level folders render as flat uppercase section
// headers (no chevron — the header itself collapses the section on click);
// inside a section, documents list flat and nested folders are disclosure
// rows indenting inward with the per-ancestor spine rule. Root-level loose
// documents sit ungrouped at the top.
//
// Collapse state is in-memory for now (resets on reopen); persisting it is a
// small follow-up. Folder management (rename/new/delete) stays out of scope,
// so folder rows are pure disclosure — no context menu.

import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import type { FileEntry, SidebarSortKey } from '@skrive/shared';
import type { ExportFormatId } from '../../lib/export';
import { IconFolder } from '../icons/IconFolder';
import { FileRow } from './FileRow';
import {
  buildSpineStyle,
  buildTree,
  fileComparator,
  spineFromChain,
  type TreeFolder
} from './tree';

type RowHandlers = {
  pinnedPaths: ReadonlySet<string>;
  onRename: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
  onTogglePin: (file: FileEntry) => void;
  onExport: (file: FileEntry, format: ExportFormatId) => void;
  onConvert: (file: FileEntry) => void;
};

type Props = RowHandlers & {
  /** The documents to show — scoped to the active filter, un-sorted (the
   *  tree sorts folders alphabetically and files by sortKey). */
  files: FileEntry[];
  sortKey: SidebarSortKey;
};

/** Documents anywhere under this folder (recursive) — the section count. */
function subtreeCount(folder: TreeFolder): number {
  return (
    folder.files.length +
    folder.folders.reduce((n, sub) => n + subtreeCount(sub), 0)
  );
}

function FileRows({
  files,
  depth,
  parentChain,
  hasFollowingFolders,
  handlers
}: {
  files: FileEntry[];
  depth: number;
  parentChain: boolean[];
  hasFollowingFolders: boolean;
  handlers: RowHandlers;
}) {
  return (
    <ul className="files">
      {files.map((file, i) => (
        <FileRow
          key={file.path}
          file={file}
          depth={depth}
          lastChild={i === files.length - 1 && !hasFollowingFolders}
          parentChain={parentChain}
          pinned={handlers.pinnedPaths.has(file.path)}
          onRename={handlers.onRename}
          onDelete={handlers.onDelete}
          onTogglePin={handlers.onTogglePin}
          onExport={handlers.onExport}
          onConvert={handlers.onConvert}
        />
      ))}
    </ul>
  );
}

// A nested folder (depth >= 0 inside a section): a disclosure row whose
// IconFolder morphs open/closed, with its subtree indented by the spine rule.
function NestedFolder({
  folder,
  depth,
  lastChild,
  parentChain,
  collapsed,
  onToggle,
  handlers
}: {
  folder: TreeFolder;
  depth: number;
  lastChild: boolean;
  parentChain: boolean[];
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  handlers: RowHandlers;
}) {
  const isExpanded = !collapsed.has(folder.path);
  const spineDepths = useMemo(
    () => spineFromChain(parentChain, lastChild, depth),
    [parentChain, lastChild, depth]
  );
  const style = useMemo(
    () => buildSpineStyle(spineDepths, depth),
    [spineDepths, depth]
  );
  const chain = useMemo(
    () => (depth > 0 ? [...parentChain, lastChild] : []),
    [parentChain, lastChild, depth]
  );

  function handleKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle(folder.path);
    }
  }

  return (
    <>
      <div
        className="dir-label"
        title={folder.path}
        tabIndex={0}
        role="button"
        aria-expanded={isExpanded}
        style={style}
        onClick={() => onToggle(folder.path)}
        onKeyDown={handleKey}
      >
        <span className="dir-icon">
          <IconFolder size={16} open={isExpanded} />
        </span>
        <span className="dir-name">{folder.name}</span>
      </div>
      {isExpanded && (
        <>
          {folder.files.length > 0 && (
            <FileRows
              files={folder.files}
              depth={depth + 1}
              parentChain={chain}
              hasFollowingFolders={folder.folders.length > 0}
              handlers={handlers}
            />
          )}
          {folder.folders.map((sub, i) => (
            <NestedFolder
              key={sub.path}
              folder={sub}
              depth={depth + 1}
              lastChild={i === folder.folders.length - 1}
              parentChain={chain}
              collapsed={collapsed}
              onToggle={onToggle}
              handlers={handlers}
            />
          ))}
        </>
      )}
    </>
  );
}

// A top-level folder: a flat uppercase section header (no chevron) that
// collapses its body on click.
function ShelfSection({
  folder,
  collapsed,
  onToggle,
  handlers
}: {
  folder: TreeFolder;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  handlers: RowHandlers;
}) {
  const isExpanded = !collapsed.has(folder.path);
  return (
    <div className="shelf-section">
      <div
        className="shelf-section__header"
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        title={folder.path}
        onClick={() => onToggle(folder.path)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(folder.path);
          }
        }}
      >
        <span className="shelf-section__icon">
          <IconFolder size={16} open={isExpanded} />
        </span>
        <span className="shelf-section__label">{folder.name}</span>
        <span className="shelf-section__count">{subtreeCount(folder)}</span>
      </div>
      {isExpanded && (
        <>
          {folder.files.length > 0 && (
            <FileRows
              files={folder.files}
              depth={0}
              parentChain={[]}
              hasFollowingFolders={folder.folders.length > 0}
              handlers={handlers}
            />
          )}
          {folder.folders.map((sub, i) => (
            <NestedFolder
              key={sub.path}
              folder={sub}
              depth={0}
              lastChild={i === folder.folders.length - 1}
              parentChain={[]}
              collapsed={collapsed}
              onToggle={onToggle}
              handlers={handlers}
            />
          ))}
        </>
      )}
    </div>
  );
}

export function ShelfTree({ files, sortKey, ...handlers }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const tree = useMemo(
    () => buildTree(files, fileComparator(sortKey)),
    [files, sortKey]
  );

  return (
    <div className="shelf-tree">
      {tree.files.length > 0 && (
        <FileRows
          files={tree.files}
          depth={0}
          parentChain={[]}
          hasFollowingFolders={false}
          handlers={handlers}
        />
      )}
      {tree.folders.map((folder) => (
        <ShelfSection
          key={folder.path}
          folder={folder}
          collapsed={collapsed}
          onToggle={toggle}
          handlers={handlers}
        />
      ))}
    </div>
  );
}
