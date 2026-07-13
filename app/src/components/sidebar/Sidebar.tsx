// The sidebar (SKR-245 — reimagined). A three-part rail: a fixed top-actions
// bar (project menu · Search · New), a scrolling middle (the desk — Pinned +
// Recents — then the flat All list), and a fixed utility bar at the bottom
// (Help · Settings).
//
// Folders are no longer a docked tree; they become a filter facet on the one
// All list (the funnel + chip land in a later step). Row/menu presentation
// lives in siblings — FileRow, Desk, AllList, SortMenu, and the path helpers
// in tree.ts. The drag-to-resize gesture lives in useSidebarResize.

import {
  useCallback,
  useEffect,
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
import type { ExportFormatId } from '../../lib/export';
import { platformShortcut } from '../../lib/commands/shortcut-display';
import { notify } from '../../lib/notify';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { DeleteConfirmModal } from '../modals/DeleteConfirmModal';
import { IconPlus } from '../icons/IconPlus';
import { IconSearch } from '../icons/IconSearch';
import { IconHelp } from '../icons/IconHelp';
import { IconSettings } from '../icons/IconSettings';
import { Desk } from './Desk';
import { AllList } from './AllList';
import { fileComparator, filesInFolder, folderList, projectName } from './tree';
import { useSidebarResize } from './useSidebarResize';

type DeleteTarget = { kind: 'file' | 'directory'; path: string; name: string };

type SidebarProps = {
  /** Open the ⌘P quick-open switcher (the Search affordance). */
  onOpenSwitcher: () => void;
  /** Open the keyboard-shortcuts cheat sheet (the Help affordance). */
  onOpenHelp: () => void;
};

export function Sidebar({ onOpenSwitcher, onOpenHelp }: SidebarProps) {
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
  const workingSet = useProjectStore((s) => s.workingSet);
  const openSettings = useProjectStore((s) => s.openSettings);
  const activeFilter = useProjectStore((s) => s.activeFilter);
  const setFilter = useProjectStore((s) => s.setFilter);
  const clearFilter = useProjectStore((s) => s.clearFilter);
  const allView = useProjectStore((s) => s.allView);
  const toggleAllView = useProjectStore((s) => s.toggleAllView);

  const [creating, setCreating] = useState<
    'folio' | 'markdown' | 'text' | 'folder' | null
  >(null);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  const pinnedPaths = useMemo(() => new Set(pinned), [pinned]);

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

  // The desk's Recents tier: the working set (LRU, entry 0 = live doc),
  // resolved to live files and deduped against the pins — a doc that is
  // both pinned and recent renders once, under Pinned. This is the same
  // array the summon fan and the ⌘P switcher read; never a copy.
  const recentFiles = useMemo(() => {
    const byPath = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
    return workingSet
      .filter((e) => !pinnedPaths.has(e.path))
      .map((e) => byPath.get(e.path))
      .filter((f): f is FileEntry => f !== undefined);
  }, [workingSet, pinnedPaths, manifest?.files]);

  // The All list: the whole project as one flat list, ordered by sortKey,
  // then scoped to the active folder filter (if any).
  const sortedFiles = useMemo(
    () => [...(manifest?.files ?? [])].sort(fileComparator(sortKey)),
    [manifest?.files, sortKey]
  );

  // Folders derived from the file paths — the filter facet's menu.
  const folders = useMemo(
    () => folderList(manifest?.files ?? []),
    [manifest?.files]
  );

  const scopedFiles = useMemo(
    () =>
      activeFilter?.kind === 'folder'
        ? filesInFolder(sortedFiles, activeFilter.value)
        : sortedFiles,
    [sortedFiles, activeFilter]
  );

  // Drop a folder scope whose folder no longer exists (its last document was
  // deleted or moved out) so the All list doesn't get stuck showing nothing.
  useEffect(() => {
    if (
      activeFilter?.kind === 'folder' &&
      !folders.some((f) => f.path === activeFilter.value)
    ) {
      clearFilter();
    }
  }, [activeFilter, folders, clearFilter]);

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
          {/* Fixed top: project menu · Search · New. */}
          <header className="sidebar-topbar">
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
                      <span className="ctx-shortcut">
                        {platformShortcut('⌘O')}
                      </span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="ctx-item"
                      onSelect={() => void closeProject()}
                    >
                      <span className="ctx-label">Close project</span>
                      <span className="ctx-shortcut">
                        {platformShortcut('⌘⇧W')}
                      </span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : (
              <span className="title">Files</span>
            )}
            <div className="sidebar-topbar__spacer" />
            <div className="sidebar-topbar__actions">
              <Tooltip label="Quick open">
                <IconButton
                  size="md"
                  className="icon-button"
                  aria-label="Quick open"
                  disabled={!manifest}
                  onClick={onOpenSwitcher}
                >
                  <IconSearch size={16} />
                </IconButton>
              </Tooltip>
              <DropdownMenu.Root>
                <Tooltip label="New file or folder">
                  <DropdownMenu.Trigger asChild>
                    <IconButton
                      size="md"
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

          {/* Scrolling middle: create input, hints, desk, All list. */}
          <div className="sidebar-scroll">
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
                This project has no markdown files yet. Click{' '}
                <strong>+</strong> to create one.
              </p>
            )}

            {!manifest && (
              <p className="empty-hint">
                No project open. Use{' '}
                <strong>{platformShortcut('⌘O')}</strong> to open a folder.
              </p>
            )}

            <Desk
              pinnedFiles={pinnedFiles}
              recentFiles={recentFiles}
              pinnedPaths={pinnedPaths}
              onRename={renameFile}
              onDelete={requestDeleteFile}
              onTogglePin={toggleFilePin}
              onExport={handleExport}
              onConvert={handleConvert}
            />

            {manifest && fileCount > 0 && (
              <AllList
                files={scopedFiles}
                totalCount={fileCount}
                sortKey={sortKey}
                onSortChange={setSortKey}
                folders={folders}
                activeFilter={activeFilter}
                onFilterSelect={setFilter}
                onFilterClear={clearFilter}
                allView={allView}
                onToggleView={toggleAllView}
                pinnedPaths={pinnedPaths}
                onRename={renameFile}
                onDelete={requestDeleteFile}
                onTogglePin={toggleFilePin}
                onExport={handleExport}
                onConvert={handleConvert}
              />
            )}
          </div>

          {/* Fixed bottom utility bar: Help · Settings. */}
          <div className="sidebar-utility">
            <Tooltip label="Keyboard shortcuts">
              <IconButton
                size="sm"
                className="icon-button"
                aria-label="Keyboard shortcuts"
                onClick={onOpenHelp}
              >
                <IconHelp size={16} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Settings">
              <IconButton
                size="sm"
                className="icon-button"
                aria-label="Settings"
                onClick={() => openSettings()}
              >
                <IconSettings size={16} />
              </IconButton>
            </Tooltip>
          </div>
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
