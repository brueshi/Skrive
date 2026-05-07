// The sidebar. Recursive directory tree with the spine-rule indent
// guides from the v0.1.5 redesign and right-click context menus.
//
// Spine rule (non-canonical, the user's IP — see memory):
//   At each row, the set of spine columns drawn comes from its
//   ancestor-lastness chain. A spine at column d is drawn iff the
//   ancestor at depth (d+1) is NOT a last child. That keeps each
//   subtree's spine confined to its own siblings — when an ancestor
//   is a last child, its column-line stops at its own elbow rather
//   than extending through descendants.
//
// Phase 4 wires the right-click context menu (delete only — rename
// modal with reference rewriting lands in Phase 6 with the link graph)
// and the delete-confirm modal. Per-project sidebar width persistence
// wires through Phase 9.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from 'react';
import type { FileEntry } from '@skrive/shared';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  selectActivePath,
  useProjectStore
} from '../../stores/project';
import { usePreferencesStore } from '../../stores/preferences';
import { resolveTitle } from '../../lib/title';
import { notify } from '../../lib/notify';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import { DeleteConfirmModal } from '../DeleteConfirmModal';
import { IconDocMarkdown } from '../icons/IconDocMarkdown';
import { IconFolder } from '../icons/IconFolder';
import { IconPlus } from '../icons/IconPlus';

type TreeFolder = {
  name: string;
  path: string;
  folders: TreeFolder[];
  files: FileEntry[];
};

function buildTree(files: FileEntry[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], files: [] };
  const byPath = new Map<string, TreeFolder>();
  byPath.set('', root);

  for (const f of files) {
    const lastSep = f.path.lastIndexOf('/');
    if (lastSep === -1) {
      root.files.push(f);
      continue;
    }
    const parts = f.path.slice(0, lastSep).split('/');
    let parent = root;
    let runningPath = '';
    for (const part of parts) {
      runningPath = runningPath ? `${runningPath}/${part}` : part;
      let next = byPath.get(runningPath);
      if (!next) {
        next = { name: part, path: runningPath, folders: [], files: [] };
        parent.folders.push(next);
        byPath.set(runningPath, next);
      }
      parent = next;
    }
    parent.files.push(f);
  }

  const sortFolder = (folder: TreeFolder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) => a.name.localeCompare(b.name));
    folder.folders.forEach(sortFolder);
  };
  sortFolder(root);

  return root;
}

function buildSpineStyle(spineDepths: number[], depth: number): CSSProperties {
  const base = { '--sb-depth': depth } as CSSProperties;
  if (spineDepths.length === 0) return base;
  const stripe =
    'linear-gradient(to right, var(--skrive-rule) 0, var(--skrive-rule) 1px, transparent 1px)';
  const images = spineDepths.map(() => stripe).join(', ');
  const positions = spineDepths
    .map((d) => `calc(1rem + ${d} * var(--sb-indent-step)) 0`)
    .join(', ');
  const sizes = spineDepths.map(() => '1px 100%').join(', ');
  const repeats = spineDepths.map(() => 'no-repeat').join(', ');
  return {
    ...base,
    backgroundImage: images,
    backgroundPosition: positions,
    backgroundSize: sizes,
    backgroundRepeat: repeats
  } as CSSProperties;
}

function spineFromChain(
  parentChain: boolean[],
  lastChild: boolean,
  depth: number
): number[] {
  if (depth === 0) return [];
  const chain = [...parentChain, lastChild];
  return chain.map((isLast, i) => (isLast ? -1 : i)).filter((d) => d >= 0);
}

// ============================ Row components ============================

type FileRowProps = {
  file: FileEntry;
  depth: number;
  lastChild: boolean;
  parentChain: boolean[];
  onContextMenu: (e: MouseEvent, file: FileEntry) => void;
  onDeleteShortcut: (file: FileEntry) => void;
};

function FileRow({
  file,
  depth,
  lastChild,
  parentChain,
  onContextMenu,
  onDeleteShortcut
}: FileRowProps) {
  const activePath = useProjectStore(selectActivePath);
  const openTab = useProjectStore((s) => s.openTab);
  const spineDepths = useMemo(
    () => spineFromChain(parentChain, lastChild, depth),
    [parentChain, lastChild, depth]
  );
  const style = useMemo(
    () => buildSpineStyle(spineDepths, depth),
    [spineDepths, depth]
  );
  const resolved = resolveTitle(file);

  function handleKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onDeleteShortcut(file);
    }
  }

  return (
    <li>
      <button
        type="button"
        className={`file${activePath === file.path ? ' active' : ''}`}
        style={style}
        onClick={() => {
          void openTab(file.path);
        }}
        onContextMenu={(e) => onContextMenu(e, file)}
        onKeyDown={handleKey}
        title={file.path}
      >
        <span className="file-icon">
          <IconDocMarkdown size={16} />
        </span>
        <span className="file-labels">
          <span className="file-title">{resolved.primary}</span>
          {resolved.secondary && (
            <span className="file-filename">{resolved.secondary}</span>
          )}
        </span>
      </button>
    </li>
  );
}

type FolderTreeProps = {
  folder: TreeFolder;
  depth: number;
  lastChild: boolean;
  parentChain: boolean[];
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onFileContextMenu: (e: MouseEvent, file: FileEntry) => void;
  onFileDeleteShortcut: (file: FileEntry) => void;
  onDirContextMenu: (e: MouseEvent, dir: string) => void;
  onDirDeleteShortcut: (dir: string) => void;
};

function FolderTree(props: FolderTreeProps) {
  const {
    folder,
    depth,
    lastChild,
    parentChain,
    collapsed,
    onToggle,
    onFileContextMenu,
    onFileDeleteShortcut,
    onDirContextMenu,
    onDirDeleteShortcut
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
      onDirDeleteShortcut(folder.path);
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
        onContextMenu={(e) => onDirContextMenu(e, folder.path)}
      >
        <span className="dir-icon">
          <IconFolder size={16} open={isExpanded} />
        </span>
        <span className="dir-name">{folder.name}</span>
      </div>
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
                  onContextMenu={onFileContextMenu}
                  onDeleteShortcut={onFileDeleteShortcut}
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

// ============================ Sidebar ============================

type DeleteTarget = { kind: 'file' | 'directory'; path: string; name: string };
type ContextMenuState = { x: number; y: number; items: ContextMenuItem[] };

export function Sidebar() {
  const manifest = useProjectStore((s) => s.manifest);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);
  const createFile = useProjectStore((s) => s.createFile);
  const createDirectory = useProjectStore((s) => s.createDirectory);
  const deleteFile = useProjectStore((s) => s.deleteFile);
  const deleteDirectory = useProjectStore((s) => s.deleteDirectory);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);

  const tree = useMemo(
    () => buildTree(manifest?.files ?? []),
    [manifest?.files]
  );

  const toggleCollapse = useCallback((p: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  // ---------- Create flow ----------

  const startCreate = useCallback((kind: 'file' | 'folder') => {
    setCreating(kind);
    setNewName('');
    setCreateError(null);
  }, []);

  const cancelCreate = useCallback(() => {
    setCreating(null);
    setNewName('');
    setCreateError(null);
  }, []);

  const confirmCreate = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      cancelCreate();
      return;
    }
    try {
      if (creating === 'file') {
        await createFile(trimmed);
      } else if (creating === 'folder') {
        await createDirectory(trimmed);
      }
      setCreating(null);
      setNewName('');
      setCreateError(null);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    }
  }, [newName, creating, createFile, createDirectory, cancelCreate]);

  const handleNewKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void confirmCreate();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelCreate();
      }
    },
    [confirmCreate, cancelCreate]
  );

  // ---------- Context menu / delete ----------

  const skipDeleteConfirm = usePreferencesStore(
    (s) => s.skipDeleteConfirmation
  );

  const requestDeleteFile = useCallback(
    (file: FileEntry) => {
      if (skipDeleteConfirm) {
        void deleteFile(file.path).catch((e) =>
          notify.error(`Couldn't delete ${file.name}`, e)
        );
        return;
      }
      setPendingDelete({ kind: 'file', path: file.path, name: file.name });
    },
    [skipDeleteConfirm, deleteFile]
  );

  const requestDeleteDirectory = useCallback(
    (dir: string) => {
      const lastSep = dir.lastIndexOf('/');
      const name = lastSep === -1 ? dir : dir.slice(lastSep + 1);
      if (skipDeleteConfirm) {
        void deleteDirectory(dir).catch((e) =>
          notify.error(`Couldn't delete ${name}`, e)
        );
        return;
      }
      setPendingDelete({ kind: 'directory', path: dir, name });
    },
    [skipDeleteConfirm, deleteDirectory]
  );

  const openFileContextMenu = useCallback(
    (e: MouseEvent, file: FileEntry) => {
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Delete…',
            shortcut: '⌫',
            variant: 'destructive',
            onClick: () => requestDeleteFile(file)
          }
        ]
      });
    },
    [requestDeleteFile]
  );

  const openDirectoryContextMenu = useCallback(
    (e: MouseEvent, dir: string) => {
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Delete folder…',
            shortcut: '⌫',
            variant: 'destructive',
            onClick: () => requestDeleteDirectory(dir)
          }
        ]
      });
    },
    [requestDeleteDirectory]
  );

  const confirmPendingDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      if (target.kind === 'file') {
        await deleteFile(target.path);
      } else {
        await deleteDirectory(target.path);
      }
    } catch (e) {
      notify.error(`Couldn't delete ${target.name}`, e);
      throw e;
    }
  }, [pendingDelete, deleteFile, deleteDirectory]);

  // ---------- Drag-to-resize ----------

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);

  const startDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, w: sidebarWidth };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [sidebarWidth]
  );

  useEffect(() => {
    if (!isDragging) return;
    function onMove(e: globalThis.PointerEvent) {
      const start = dragStartRef.current;
      if (!start) return;
      setSidebarWidth(start.w + (e.clientX - start.x));
    }
    function onUp() {
      setIsDragging(false);
      dragStartRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isDragging, setSidebarWidth]);

  const resetWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, [setSidebarWidth]);

  const fileCount = manifest?.files.length ?? 0;
  const sidebarStyle = {
    '--skrive-sidebar-width': `${sidebarWidth}px`
  } as CSSProperties;

  return (
    <>
      <aside
        className={`sidebar${sidebarVisible ? '' : ' collapsed'}${
          isDragging ? ' dragging' : ''
        }`}
        style={sidebarStyle}
        aria-label="Files"
        aria-hidden={!sidebarVisible}
        // @ts-expect-error inert is a string attribute in HTML
        inert={!sidebarVisible ? '' : undefined}
      >
        <header className="section-header">
          <span className="title">Files</span>
          <div className="section-header__actions">
            <button
              type="button"
              className="icon-button"
              aria-label="New file or folder"
              title="New file or folder"
              onClick={() => setPlusOpen((v) => !v)}
              disabled={creating !== null || !manifest}
            >
              <IconPlus size={16} />
            </button>
            {plusOpen && (
              <div
                className="plus-menu"
                role="menu"
                onMouseLeave={() => setPlusOpen(false)}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    startCreate('file');
                  }}
                >
                  New file
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    startCreate('folder');
                  }}
                >
                  New folder
                </button>
              </div>
            )}
          </div>
        </header>

        {creating !== null && (
          <div className="new-file-row">
            <input
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleNewKey}
              onBlur={() => void confirmCreate()}
              placeholder={creating === 'file' ? 'filename.md' : 'folder-name'}
            />
            {createError && <p className="create-error">{createError}</p>}
          </div>
        )}

        {fileCount === 0 && creating === null && manifest && (
          <p className="empty-hint">
            This project has no markdown files yet. Click <strong>+</strong> to
            create one.
          </p>
        )}

        {!manifest && (
          <p className="empty-hint">
            No project open. Use <strong>⌘O</strong> to open a folder.
          </p>
        )}

        <div className="file-groups">
          {tree.files.length > 0 && (
            <ul className="files">
              {tree.files.map((file, i) => (
                <FileRow
                  key={file.path}
                  file={file}
                  depth={0}
                  lastChild={
                    i === tree.files.length - 1 && tree.folders.length === 0
                  }
                  parentChain={[]}
                  onContextMenu={openFileContextMenu}
                  onDeleteShortcut={requestDeleteFile}
                />
              ))}
            </ul>
          )}
          {tree.folders.map((folder, i) => (
            <FolderTree
              key={folder.path}
              folder={folder}
              depth={0}
              lastChild={i === tree.folders.length - 1}
              parentChain={[]}
              collapsed={collapsed}
              onToggle={toggleCollapse}
              onFileContextMenu={openFileContextMenu}
              onFileDeleteShortcut={requestDeleteFile}
              onDirContextMenu={openDirectoryContextMenu}
              onDirDeleteShortcut={requestDeleteDirectory}
            />
          ))}
        </div>
      </aside>

      {sidebarVisible && (
        <div
          className={`resize-handle${isDragging ? ' dragging' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          onPointerDown={startDrag}
          onDoubleClick={resetWidth}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onDismiss={() => setContextMenu(null)}
        />
      )}

      <DeleteConfirmModal
        open={pendingDelete !== null}
        name={pendingDelete?.name ?? ''}
        isDirectory={pendingDelete?.kind === 'directory'}
        onConfirm={confirmPendingDelete}
        onClose={() => setPendingDelete(null)}
      />
    </>
  );
}
