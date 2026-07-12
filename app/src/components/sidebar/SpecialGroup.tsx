// A flat, labelled group surfaced above the folder tree (Favorites, Recents).
// Rows render at depth 0 with no spine guides. Renders nothing when empty so
// the zones only appear when they hold something.

import type { ReactNode } from 'react';
import type { FileEntry } from '@skrive/shared';
import type { ExportFormatId } from '../../lib/export';
import { FileRow } from './FileRow';

export type SpecialGroupProps = {
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

export function SpecialGroup({
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
