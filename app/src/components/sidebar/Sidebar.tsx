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
  type PointerEvent,
  type ReactNode
} from 'react';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { Tooltip } from '../ui/Tooltip';
import type { FileEntry, SidebarSortKey } from '@skrive/shared';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  selectLiveDocPath,
  useProjectStore
} from '../../stores/project';
import { usePreferencesStore } from '../../stores/preferences';
import { resolveTitle } from '../../lib/title';
import { fileMode } from '../../stores/save';
import { EXPORT_FORMATS, type ExportFormatId } from '../../lib/export';
import { importKind } from '../../lib/import';
import { platformShortcut } from '../../lib/commands/shortcut-display';
import { notify } from '../../lib/notify';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { DeleteConfirmModal } from '../modals/DeleteConfirmModal';
import { DocIcon } from '../icons/DocIcon';
import { IconClock } from '../icons/IconClock';
import { IconFolder } from '../icons/IconFolder';
import { IconPlus } from '../icons/IconPlus';
import { IconSort } from '../icons/IconSort';
import { IconStar } from '../icons/IconStar';

/** How many recently-opened files the Recents zone shows. */
const RECENT_DISPLAY_CAP = 5;

const SORT_LABELS: Record<SidebarSortKey, string> = {
  name: 'Name',
  modified: 'Recently modified',
  created: 'Recently created'
};

type FileCompare = (a: FileEntry, b: FileEntry) => number;

// Comparator for the "All" tree's files. Folders always stay alphabetical
// (a folder has no meaningful modified/created stamp of its own).
function fileComparator(sortKey: SidebarSortKey): FileCompare {
  switch (sortKey) {
    case 'modified':
      return (a, b) =>
        (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) ||
        a.name.localeCompare(b.name);
    case 'created':
      // createdMs lands with the native scanner (Zig core) in SKR-138 —
      // until then this falls back to modified time, and the sort menu
      // doesn't yet offer the option.
      return (a, b) =>
        (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) ||
        a.name.localeCompare(b.name);
    case 'name':
    default:
      return (a, b) => a.name.localeCompare(b.name);
  }
}

type TreeFolder = {
  name: string;
  path: string;
  folders: TreeFolder[];
  files: FileEntry[];
};

function projectName(root: string | null | undefined): string {
  if (!root) return '';
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

function buildTree(files: FileEntry[], fileCompare: FileCompare): TreeFolder {
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
    folder.files.sort(fileCompare);
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
  pinned: boolean;
  onRename: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
  onTogglePin: (file: FileEntry) => void;
  onExport: (file: FileEntry, format: ExportFormatId) => void;
  onConvert: (file: FileEntry) => void;
};

function FileRow({
  file,
  depth,
  lastChild,
  parentChain,
  pinned,
  onRename,
  onDelete,
  onTogglePin,
  onExport,
  onConvert
}: FileRowProps) {
  const activePath = useProjectStore(selectLiveDocPath);
  const openDoc = useProjectStore((s) => s.openDoc);
  const spineDepths = useMemo(
    () => spineFromChain(parentChain, lastChild, depth),
    [parentChain, lastChild, depth]
  );
  const style = useMemo(
    () => buildSpineStyle(spineDepths, depth),
    [spineDepths, depth]
  );
  const resolved = resolveTitle(file);
  const isFolio = fileMode(file.path) === 'rich';
  const canConvert = importKind(file.path) !== null;

  function handleKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onDelete(file);
    }
  }

  return (
    <li>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            type="button"
            className={`file${activePath === file.path ? ' active' : ''}`}
            style={style}
            onClick={() => {
              void openDoc(file.path);
            }}
            onKeyDown={handleKey}
            title={file.path}
          >
            <span className="file-icon">
              <DocIcon path={file.path} size={16} />
            </span>
            <span className="file-labels">
              <span className="file-title">{resolved.primary}</span>
              {resolved.secondary && (
                <span className="file-filename">{resolved.secondary}</span>
              )}
            </span>
            {pinned && (
              <span className="file-pin-marker" aria-hidden="true">
                <IconStar size={16} filled />
              </span>
            )}
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="ctx-menu">
            <ContextMenu.Item
              className="ctx-item"
              onSelect={() => onTogglePin(file)}
            >
              <span className="ctx-label">
                {pinned ? 'Remove from Favorites' : 'Pin to Favorites'}
              </span>
            </ContextMenu.Item>
            <ContextMenu.Item
              className="ctx-item"
              onSelect={() => onRename(file)}
            >
              <span className="ctx-label">Rename…</span>
              <span className="ctx-shortcut">F2</span>
            </ContextMenu.Item>
            {isFolio && (
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger className="ctx-item">
                  <span className="ctx-label">Export as</span>
                  <span className="ctx-shortcut" aria-hidden="true">
                    ›
                  </span>
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent className="ctx-menu" sideOffset={2}>
                    {EXPORT_FORMATS.map((fmt) => (
                      <ContextMenu.Item
                        key={fmt.id}
                        className="ctx-item"
                        onSelect={() => onExport(file, fmt.id)}
                      >
                        <span className="ctx-label">{fmt.label}</span>
                      </ContextMenu.Item>
                    ))}
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
            )}
            {canConvert && (
              <ContextMenu.Item
                className="ctx-item"
                onSelect={() => onConvert(file)}
              >
                <span className="ctx-label">Convert to Skrive document</span>
              </ContextMenu.Item>
            )}
            <ContextMenu.Separator className="ctx-sep" />
            <ContextMenu.Item
              className="ctx-item destructive"
              onSelect={() => onDelete(file)}
            >
              <span className="ctx-label">Delete…</span>
              <span className="ctx-shortcut">⌫</span>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </li>
  );
}

type FolderTreeProps = {
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

function FolderTree(props: FolderTreeProps) {
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

// ============================ Special groups ============================

// A flat, labelled group surfaced above the folder tree (Favorites, Recents).
// Rows render at depth 0 with no spine guides. Renders nothing when empty so
// the zones only appear when they hold something.
type SpecialGroupProps = {
  title: string;
  icon: ReactNode;
  files: FileEntry[];
  pinnedPaths: ReadonlySet<string>;
  onRename: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
  onTogglePin: (file: FileEntry) => void;
  onExport: (file: FileEntry, format: ExportFormatId) => void;
  onConvert: (file: FileEntry) => void;
};

function SpecialGroup({
  title,
  icon,
  files,
  pinnedPaths,
  onRename,
  onDelete,
  onTogglePin,
  onExport,
  onConvert
}: SpecialGroupProps) {
  if (files.length === 0) return null;
  return (
    <div className="sidebar-pins">
      <div className="sidebar-pins__header">
        {icon}
        <span className="sidebar-pins__title">{title}</span>
        <span className="sidebar-pins__count">{files.length}</span>
      </div>
      <ul className="files">
        {files.map((file, i) => (
          <FileRow
            key={file.path}
            file={file}
            depth={0}
            lastChild={i === files.length - 1}
            parentChain={[]}
            pinned={pinnedPaths.has(file.path)}
            onRename={onRename}
            onDelete={onDelete}
            onTogglePin={onTogglePin}
            onExport={onExport}
            onConvert={onConvert}
          />
        ))}
      </ul>
    </div>
  );
}

// Sort control for the "All" tree. Currently offers Name + Recently
// modified; Recently created joins once the native scanner supplies a
// birthtime. Persists via the store's setSortKey.
function SortMenu({
  sortKey,
  onChange
}: {
  sortKey: SidebarSortKey;
  onChange: (key: SidebarSortKey) => void;
}) {
  const options: SidebarSortKey[] = ['name', 'modified'];
  return (
    <DropdownMenu.Root>
      <Tooltip label={`Sort: ${SORT_LABELS[sortKey]}`}>
        <DropdownMenu.Trigger asChild>
          <IconButton size="sm" className="icon-button" aria-label="Sort files">
            <IconSort size={16} />
          </IconButton>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ctx-menu" align="end" sideOffset={4}>
          {options.map((key) => (
            <DropdownMenu.Item
              key={key}
              className="ctx-item"
              onSelect={() => onChange(key)}
            >
              <span className="ctx-label">{SORT_LABELS[key]}</span>
              {sortKey === key && <span className="ctx-shortcut">✓</span>}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ============================ Sidebar ============================

type DeleteTarget = { kind: 'file' | 'directory'; path: string; name: string };

export function Sidebar() {
  const manifest = useProjectStore((s) => s.manifest);
  const openProjectFromDialog = useProjectStore(
    (s) => s.openProjectFromDialog
  );
  const closeProject = useProjectStore((s) => s.closeProject);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);
  const setSidebarVisible = useProjectStore((s) => s.setSidebarVisible);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const createFile = useProjectStore((s) => s.createFile);
  const createTextFile = useProjectStore((s) => s.createTextFile);
  const createFolioDocument = useProjectStore((s) => s.createFolioDocument);
  const createDirectory = useProjectStore((s) => s.createDirectory);
  const deleteFile = useProjectStore((s) => s.deleteFile);
  const deleteDirectory = useProjectStore((s) => s.deleteDirectory);
  const exportDocument = useProjectStore((s) => s.exportDocument);
  const convertToFolio = useProjectStore((s) => s.convertToFolio);
  const pinned = useProjectStore((s) => s.pinned);
  const togglePin = useProjectStore((s) => s.togglePin);
  const sortKey = useProjectStore((s) => s.sortKey);
  const setSortKey = useProjectStore((s) => s.setSortKey);
  const recentFiles = usePreferencesStore((s) => s.recentFiles);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [creating, setCreating] = useState<
    'folio' | 'markdown' | 'text' | 'folder' | null
  >(null);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  const tree = useMemo(
    () => buildTree(manifest?.files ?? [], fileComparator(sortKey)),
    [manifest?.files, sortKey]
  );

  const pinnedPaths = useMemo(() => new Set(pinned), [pinned]);

  // Recently-opened files for this project, most-recent first, resolved to
  // live files (skipping any that have since gone away) and capped. Same
  // source + filtering as the command-palette switcher.
  const recentEntries = useMemo(() => {
    if (!manifest) return [];
    const byPath = new Map(manifest.files.map((f) => [f.path, f]));
    return recentFiles
      .filter((r) => r.projectPath === manifest.root)
      .map((r) => byPath.get(r.filePath))
      .filter((f): f is FileEntry => f !== undefined)
      .slice(0, RECENT_DISPLAY_CAP);
  }, [recentFiles, manifest]);

  // Resolve pins to live files in pin order, skipping any whose file has
  // gone away. Deletes/renames prune the stored list, so a miss here is
  // only a transient window between a watcher event and the store catching
  // up — rendering nothing for it is the safe outcome.
  const pinnedFiles = useMemo(() => {
    const byPath = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
    return pinned
      .map((p) => byPath.get(p))
      .filter((f): f is FileEntry => f !== undefined);
  }, [pinned, manifest?.files]);

  const toggleFilePin = useCallback(
    (file: FileEntry) => togglePin(file.path),
    [togglePin]
  );

  const handleExport = useCallback(
    (file: FileEntry, format: ExportFormatId) => {
      void exportDocument(file.path, format);
    },
    [exportDocument]
  );

  const handleConvert = useCallback(
    (file: FileEntry) => {
      void convertToFolio(file.path);
    },
    [convertToFolio]
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

  const startCreate = useCallback(
    (kind: 'folio' | 'markdown' | 'text' | 'folder') => {
      setCreating(kind);
      setNewName('');
      setCreateError(null);
    },
    []
  );

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
      if (creating === 'folio') {
        await createFolioDocument(trimmed);
      } else if (creating === 'markdown') {
        await createFile(trimmed);
      } else if (creating === 'text') {
        await createTextFile(trimmed);
      } else if (creating === 'folder') {
        await createDirectory(trimmed);
      }
      setCreating(null);
      setNewName('');
      setCreateError(null);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    }
  }, [
    newName,
    creating,
    createFolioDocument,
    createFile,
    createTextFile,
    createDirectory,
    cancelCreate
  ]);

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

  const openRenameModal = useProjectStore((s) => s.openRenameModal);

  const renameFile = useCallback(
    (file: FileEntry) => openRenameModal(file.path),
    [openRenameModal]
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
  //
  // The drag is driven imperatively: on every pointer move we write the
  // width CSS var straight to the DOM (coalesced to one rAF per frame) and
  // only commit to the store on release. Routing each move through React
  // state would re-render the whole tree per frame and stutter the drag.

  const asideRef = useRef<HTMLElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const rafRef = useRef<number | null>(null);
  const pendingXRef = useRef(0);
  // Last width written during the current drag; committed to the store on
  // release. Stays put when a drag collapses (below the threshold) so
  // re-opening returns to the pre-drag size.
  const dragWidthRef = useRef(sidebarWidth);
  // Tears down the in-flight drag (listeners, rAF, body styles). Stored in a
  // ref so an unmount mid-drag — or the next press — can call it too.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // Set true once a press becomes a real drag, so the `click` that trails a
  // drag doesn't also toggle the sidebar.
  const justDraggedRef = useRef(false);

  const CLICK_MOVE_THRESHOLD_PX = 4;
  // Pulling the handle left past this width snaps the sidebar shut. The
  // stored width stays put, so re-opening returns to the prior size.
  const COLLAPSE_THRESHOLD_PX = 100;

  // Pointer events here handle *dragging only* (resize + drag-to-collapse).
  // Collapse/reveal on a plain click is owned by onClick below, because
  // WKWebView doesn't reliably deliver pointerup for a motionless press —
  // only the high-level `click` event survives that. The drag doesn't engage
  // (no cursor/isDragging) until the pointer actually moves past the
  // threshold, so a motionless press leaves no state to clean up.
  const startDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      dragCleanupRef.current?.(); // clear any dangling gesture
      const el = e.currentTarget;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startW = sidebarWidth;
      dragWidthRef.current = sidebarWidth;
      justDraggedRef.current = false;
      let moved = false;

      const cleanup = () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        try {
          el.releasePointerCapture(pointerId);
        } catch {
          // Not captured / already released — ignore.
        }
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragCleanupRef.current = null;
        setIsDragging(false);
      };

      const apply = () => {
        rafRef.current = null;
        const dx = pendingXRef.current - startX;
        if (!moved && Math.abs(dx) <= CLICK_MOVE_THRESHOLD_PX) return;
        if (!moved) {
          // First real movement — engage the drag.
          moved = true;
          justDraggedRef.current = true;
          setIsDragging(true);
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }
        const raw = startW + dx;
        if (raw < COLLAPSE_THRESHOLD_PX) {
          cleanup();
          setSidebarVisible(false); // dragged shut; keep stored width
          return;
        }
        const clamped = Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, raw)
        );
        dragWidthRef.current = clamped;
        asideRef.current?.style.setProperty(
          '--skrive-sidebar-width',
          `${clamped}px`
        );
      };

      function onMove(ev: globalThis.PointerEvent) {
        pendingXRef.current = ev.clientX;
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(apply);
        }
      }
      function onUp() {
        const wasResize = moved;
        cleanup();
        if (wasResize) setSidebarWidth(dragWidthRef.current);
        // A motionless release is a click — onClick handles the toggle.
      }

      try {
        el.setPointerCapture(pointerId);
      } catch {
        // Capture is best-effort; element listeners still fire without it.
      }
      dragCleanupRef.current = cleanup;
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    },
    [sidebarWidth, setSidebarWidth, setSidebarVisible]
  );

  // Click owns collapse/reveal — the one release event WKWebView delivers
  // reliably. Ignores the click that trails a drag (resize / drag-collapse).
  const toggleFromHandle = useCallback(() => {
    dragCleanupRef.current?.();
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    toggleSidebar();
  }, [toggleSidebar]);

  // Safety net: tear down a drag if the component unmounts mid-gesture.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const fileCount = manifest?.files.length ?? 0;
  const sidebarStyle = {
    '--skrive-sidebar-width': `${sidebarWidth}px`
  } as CSSProperties;

  return (
    <>
      <aside
        ref={asideRef}
        className={`sidebar${sidebarVisible ? '' : ' collapsed'}${
          isDragging ? ' dragging' : ''
        }`}
        style={sidebarStyle}
        aria-label="Files"
        aria-hidden={!sidebarVisible}
        // @ts-expect-error inert is a string attribute in HTML
        inert={!sidebarVisible ? '' : undefined}
      >
        {/* Inner keeps its full width as the rail collapses and slides out
            via translateX, so rows glide off rather than squishing to fit. */}
        <div className="sidebar-inner">
        <header className="section-header">
          {manifest ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="project-name"
                  title={manifest.root}
                >
                  <span className="project-name-text">
                    {projectName(manifest.root)}
                  </span>
                  <span className="project-name-caret" aria-hidden="true">
                    ▾
                  </span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="ctx-menu"
                  align="start"
                  sideOffset={4}
                >
                  <DropdownMenu.Item
                    className="ctx-item"
                    onSelect={() => void openProjectFromDialog()}
                  >
                    <span className="ctx-label">Open project…</span>
                    <span className="ctx-shortcut">{platformShortcut('⌘O')}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="ctx-item"
                    onSelect={() => void closeProject()}
                  >
                    <span className="ctx-label">Close project</span>
                    <span className="ctx-shortcut">{platformShortcut('⌘⇧W')}</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : (
            <span className="title">Files</span>
          )}
          <div className="section-header__actions">
            <DropdownMenu.Root>
              <Tooltip label="New file or folder">
                <DropdownMenu.Trigger asChild>
                  <IconButton
                    size="sm"
                    className="icon-button"
                    aria-label="New file or folder"
                    disabled={creating !== null || !manifest}
                  >
                    <IconPlus size={16} />
                  </IconButton>
                </DropdownMenu.Trigger>
              </Tooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="ctx-menu"
                  align="end"
                  sideOffset={4}
                >
                  <DropdownMenu.Item
                    className="ctx-item"
                    onSelect={() => startCreate('folio')}
                  >
                    <span className="ctx-label">New file</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="ctx-item"
                    onSelect={() => startCreate('markdown')}
                  >
                    <span className="ctx-label">New Markdown file</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="ctx-item"
                    onSelect={() => startCreate('text')}
                  >
                    <span className="ctx-label">New text file</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="ctx-item"
                    onSelect={() => startCreate('folder')}
                  >
                    <span className="ctx-label">New folder</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>

        {creating !== null && (
          <div className="new-file-row">
            <Input
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleNewKey}
              onBlur={() => void confirmCreate()}
              placeholder={
                creating === 'folio'
                  ? 'document name'
                  : creating === 'markdown'
                    ? 'filename.md'
                    : creating === 'text'
                      ? 'filename.txt'
                      : 'folder-name'
              }
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
            No project open. Use <strong>{platformShortcut('⌘O')}</strong> to
            open a folder.
          </p>
        )}

        <SpecialGroup
          title="Favorites"
          icon={<IconStar size={16} filled />}
          files={pinnedFiles}
          pinnedPaths={pinnedPaths}
          onRename={renameFile}
          onDelete={requestDeleteFile}
          onTogglePin={toggleFilePin}
          onExport={handleExport}
          onConvert={handleConvert}
        />
        <SpecialGroup
          title="Recents"
          icon={<IconClock size={16} />}
          files={recentEntries}
          pinnedPaths={pinnedPaths}
          onRename={renameFile}
          onDelete={requestDeleteFile}
          onTogglePin={toggleFilePin}
          onExport={handleExport}
          onConvert={handleConvert}
        />

        {manifest && fileCount > 0 && (
          <>
            <div className="sidebar-pins__header sidebar-all-header">
              <span className="sidebar-pins__title">All</span>
              <span className="sidebar-pins__count">{fileCount}</span>
              <SortMenu sortKey={sortKey} onChange={setSortKey} />
            </div>
            <div className="file-groups">
              {tree.files.length > 0 && (
                <ul className="files">
                  {tree.files.map((file, i) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      depth={0}
                      lastChild={
                        i === tree.files.length - 1 &&
                        tree.folders.length === 0
                      }
                      parentChain={[]}
                      pinned={pinnedPaths.has(file.path)}
                      onRename={renameFile}
                      onDelete={requestDeleteFile}
                      onTogglePin={toggleFilePin}
                      onExport={handleExport}
                      onConvert={handleConvert}
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
                  pinnedPaths={pinnedPaths}
                  onToggle={toggleCollapse}
                  onFileRename={renameFile}
                  onFileDelete={requestDeleteFile}
                  onFileTogglePin={toggleFilePin}
                  onFileExport={handleExport}
                  onFileConvert={handleConvert}
                  onDirDelete={requestDeleteDirectory}
                />
              ))}
            </div>
          </>
        )}
        </div>
      </aside>

      {/* Always mounted. When the sidebar is open it's the resize handle;
          when collapsed it becomes a thin, invisible edge strip that reveals
          the sidebar on click (a faint line surfaces on hover). */}
      <div
        className={`resize-handle${isDragging ? ' dragging' : ''}${
          sidebarVisible ? '' : ' reveal'
        }`}
        role={sidebarVisible ? 'separator' : 'button'}
        aria-orientation={sidebarVisible ? 'vertical' : undefined}
        aria-label={sidebarVisible ? 'Resize sidebar' : 'Show sidebar'}
        aria-valuenow={sidebarVisible ? sidebarWidth : undefined}
        aria-valuemin={sidebarVisible ? SIDEBAR_MIN_WIDTH : undefined}
        aria-valuemax={sidebarVisible ? SIDEBAR_MAX_WIDTH : undefined}
        tabIndex={0}
        onPointerDown={sidebarVisible ? startDrag : undefined}
        onClick={toggleFromHandle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleSidebar();
          }
        }}
      />

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
