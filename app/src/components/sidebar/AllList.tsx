// The "All" section (SKR-245) — the browsable document list. One flat list,
// no folder tree: folders became a filter facet (the funnel + chip land in a
// later step). The header carries the count and the Sort control; the rows
// are plain depth-0 FileRows over the whole project, ordered by sortKey.

import type { FileEntry, SidebarSortKey } from '@skrive/shared';
import type { ExportFormatId } from '../../lib/export';
import { FileRow } from './FileRow';
import { SortMenu } from './SortMenu';

type Props = {
  /** The documents to show — the whole project, already sorted. */
  files: FileEntry[];
  /** Count shown in the header (the whole project, not the shown subset). */
  totalCount: number;
  sortKey: SidebarSortKey;
  onSortChange: (key: SidebarSortKey) => void;
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
  pinnedPaths,
  onRename,
  onDelete,
  onTogglePin,
  onExport,
  onConvert
}: Props) {
  return (
    <div className="sidebar-browse">
      <div className="sidebar-browse__header">
        <span className="sidebar-browse__label">All</span>
        <span className="sidebar-browse__count">{totalCount}</span>
        <span className="sidebar-browse__spacer" />
        <SortMenu sortKey={sortKey} onChange={onSortChange} />
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
