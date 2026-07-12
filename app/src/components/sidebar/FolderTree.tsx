// Recursive folder node in the "All" tree. Renders its own disclosure
// row (with a delete-folder context menu) and, when expanded, its files
// then its sub-folders — each carrying the spine-rule indent chain.

import { useMemo, type KeyboardEvent } from 'react';
import type { FileEntry } from '@skrive/shared';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { ExportFormatId } from '../../lib/export';
import { IconFolder } from '../icons/IconFolder';
import { FileRow } from './FileRow';
import { buildSpineStyle, spineFromChain, type TreeFolder } from './tree';

export type FolderTreeProps = {
  folder: TreeFolder;
  depth: number;
  lastChild: boolean;
  parentChain: boolean[];
  collapsed: ReadonlySet<string>;
  pinnedPaths: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onFileRename: (file: FileEntry) => void;
  onFileDelete: (file: FileEntry) => void;
  onFileTogglePin: (file: FileEntry) => void;
  onFileExport: (file: FileEntry, format: ExportFormatId) => void;
  onFileConvert: (file: FileEntry) => void;
  onDirDelete: (dir: string) => void;
};

export function FolderTree(props: FolderTreeProps) {
  const {
    folder,
    depth,
    lastChild,
    parentChain,
    collapsed,
    pinnedPaths,
    onToggle,
    onFileRename,
    onFileDelete,
    onFileTogglePin,
    onFileExport,
    onFileConvert,
    onDirDelete
  } = props;
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
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onDirDelete(folder.path);
    }
  }

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
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
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="ctx-menu">
            <ContextMenu.Item
              className="ctx-item destructive"
              onSelect={() => onDirDelete(folder.path)}
            >
              <span className="ctx-label">Delete folder…</span>
              <span className="ctx-shortcut">⌫</span>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {isExpanded && (
        <>
          {folder.files.length > 0 && (
            <ul className="files">
              {folder.files.map((file, i) => (
                <FileRow
                  key={file.path}
                  file={file}
                  depth={depth + 1}
                  lastChild={
                    i === folder.files.length - 1 && folder.folders.length === 0
                  }
                  parentChain={chain}
                  pinned={pinnedPaths.has(file.path)}
                  onRename={onFileRename}
                  onDelete={onFileDelete}
                  onTogglePin={onFileTogglePin}
                  onExport={onFileExport}
                  onConvert={onFileConvert}
                />
              ))}
            </ul>
          )}
          {folder.folders.map((sub, i) => (
            <FolderTree
              {...props}
              key={sub.path}
              folder={sub}
              depth={depth + 1}
              lastChild={i === folder.folders.length - 1}
              parentChain={chain}
            />
          ))}
        </>
      )}
    </>
  );
}
