// The sidebar. Orchestrates the project header, create flow, the Favorites
// and Recents special groups, and the recursive "All" directory tree.
//
// Row/tree/menu presentation lives in siblings — FileRow, FolderTree,
// SpecialGroup, SortMenu, and the tree/spine helpers in tree.ts. The
// drag-to-resize gesture lives in useSidebarResize.
//
// Phase 4 wires the right-click context menu (delete only — rename modal
// with reference rewriting lands in Phase 6 with the link graph) and the
// delete-confirm modal. Per-project sidebar width persistence wires through
// Phase 9.

import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from 'react';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { Tooltip } from '../ui/Tooltip';
import type { FileEntry } from '@skrive/shared';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useProjectStore
} from '../../stores/project';
import { usePreferencesStore } from '../../stores/preferences';
import { EXPORT_FORMATS, type ExportFormatId } from '../../lib/export';
import { platformShortcut } from '../../lib/commands/shortcut-display';
import { notify } from '../../lib/notify';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { DeleteConfirmModal } from '../modals/DeleteConfirmModal';
import { IconClock } from '../icons/IconClock';
import { IconPlus } from '../icons/IconPlus';
import { IconStar } from '../icons/IconStar';
import { FolderTree } from './FolderTree';
import { FileRow } from './FileRow';
import { SpecialGroup } from './SpecialGroup';
import { SortMenu } from './SortMenu';
import { buildTree, fileComparator, projectName } from './tree';
import { useSidebarResize } from './useSidebarResize';

/** How many recently-opened files the Recents zone shows. */
const RECENT_DISPLAY_CAP = 5;

type DeleteTarget = { kind: 'file' | 'directory'; path: string; name: string };

export function Sidebar() {
  const manifest = useProjectStore((s) => s.manifest);
  const openProjectFromDialog = useProjectStore(
    (s) => s.openProjectFromDialog
  );
  const closeProject = useProjectStore((s) => s.closeProject);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
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

  const { asideRef, isDragging, startDrag, toggleFromHandle } =
    useSidebarResize();

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
