// The "All" section (SKR-245) — the browsable document list. One flat list,
// no folder tree: folders are a filter facet. The header carries the total
// count, the Sort control, and the Filter (funnel). When a folder scope is
// active, a removable chip sits under the header with the sort summary
// alongside, and the rows are scoped to that folder.

import type {
  FileEntry,
  SidebarAllView,
  SidebarFilter,
  SidebarSortKey
} from '@skrive/shared';
import type { ExportFormatId } from '../../lib/export';
import { FileRow } from './FileRow';
import { ShelfTree } from './ShelfTree';
import { SortMenu, SORT_LABELS } from './SortMenu';
import { FilterMenu } from './FilterMenu';
import { Tooltip } from '../ui/Tooltip';
import { IconFolder } from '../icons/IconFolder';
import { IconList } from '../icons/IconList';
import { IconX } from '../icons/IconX';
import type { FolderInfo } from './tree';

type Props = {
  /** The documents to show — scoped to the active filter, already sorted. */
  files: FileEntry[];
  /** Count shown in the header (the whole project, not the shown subset). */
  totalCount: number;
  sortKey: SidebarSortKey;
  onSortChange: (key: SidebarSortKey) => void;
  folders: FolderInfo[];
  activeFilter: SidebarFilter | null;
  onFilterSelect: (filter: SidebarFilter) => void;
  onFilterClear: () => void;
  allView: SidebarAllView;
  onSetView: (view: SidebarAllView) => void;
  pinnedPaths: ReadonlySet<string>;
  onRename: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
  onTogglePin: (file: FileEntry) => void;
  onExport: (file: FileEntry, format: ExportFormatId) => void;
  onConvert: (file: FileEntry) => void;
};

export function AllList({
  files,
  totalCount,
  sortKey,
  onSortChange,
  folders,
  activeFilter,
  onFilterSelect,
  onFilterClear,
  allView,
  onSetView,
  pinnedPaths,
  onRename,
  onDelete,
  onTogglePin,
  onExport,
  onConvert
}: Props) {
  const activeFolder =
    activeFilter?.kind === 'folder'
      ? folders.find((f) => f.path === activeFilter.value)
      : undefined;
  const sortSummary = SORT_LABELS[sortKey].toLowerCase();
  const isTree = allView === 'tree';
  const canBrowseTree = folders.length > 0;

  const handlers = {
    pinnedPaths,
    onRename,
    onDelete,
    onTogglePin,
    onExport,
    onConvert
  };

  return (
    <div className="sidebar-browse">
      <div className="sidebar-browse__header">
        <span className="sidebar-browse__label">All</span>
        <span className="sidebar-browse__count">{totalCount}</span>
        <span className="sidebar-browse__spacer" />
        {canBrowseTree && (
          // Segmented flat/folders switch — both views always visible, the
          // active one filled, one click to switch.
          <div
            className="sidebar-browse__seg"
            role="group"
            aria-label="All view"
          >
            <Tooltip label="Flat list">
              <button
                type="button"
                className={`sidebar-browse__seg-btn${!isTree ? ' active' : ''}`}
                aria-pressed={!isTree}
                aria-label="Flat list"
                onClick={() => onSetView('flat')}
              >
                <IconList size={16} />
              </button>
            </Tooltip>
            <Tooltip label="Folders">
              <button
                type="button"
                className={`sidebar-browse__seg-btn${isTree ? ' active' : ''}`}
                aria-pressed={isTree}
                aria-label="Folders"
                onClick={() => onSetView('tree')}
              >
                <IconFolder size={16} />
              </button>
            </Tooltip>
          </div>
        )}
        <SortMenu sortKey={sortKey} onChange={onSortChange} />
        <FilterMenu
          folders={folders}
          activeFilter={activeFilter}
          onSelect={onFilterSelect}
          onClear={onFilterClear}
        />
      </div>

      {activeFolder && (
        <div className="sidebar-browse__chiprow">
          <button
            type="button"
            className="filter-chip"
            aria-label={`Clear folder filter: ${activeFolder.name}`}
            title={activeFolder.path}
            onClick={onFilterClear}
          >
            <span className="filter-chip__icon">
              <IconFolder size={16} />
            </span>
            <span className="filter-chip__name">{activeFolder.name}</span>
            <span className="filter-chip__count">{activeFolder.count}</span>
            <span className="filter-chip__x">
              <IconX size={16} />
            </span>
          </button>
          <span className="filter-chip__sort">· {sortSummary}</span>
        </div>
      )}

      {isTree && canBrowseTree ? (
        <ShelfTree files={files} sortKey={sortKey} {...handlers} />
      ) : (
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
      )}
    </div>
  );
}
