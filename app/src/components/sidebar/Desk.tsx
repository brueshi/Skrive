// The writer's desk (SKR-243) — the sidebar's curated top tier.
//
// One model-level list, two membership kinds, plain labels: Pinned rows
// (never evicted, manual order) then Recents (the working set, LRU). A
// document that is both pinned and recent renders once, under Pinned — the
// caller dedupes the Recents list against the pins.
//
// Rows are documents today, but the desk is where non-document objects
// land later (SKR-57 Today); it renders FileRows for now without baking in
// a document-only assumption at the tier level.

import type { FileEntry } from '@skrive/shared';
import type { ExportFormatId } from '../../lib/export';
import { FileRow } from './FileRow';

type RowHandlers = {
  pinnedPaths: ReadonlySet<string>;
  onRename: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
  onTogglePin: (file: FileEntry) => void;
  onExport: (file: FileEntry, format: ExportFormatId) => void;
  onConvert: (file: FileEntry) => void;
};

export type DeskProps = RowHandlers & {
  pinnedFiles: FileEntry[];
  recentFiles: FileEntry[];
};

function DeskRows({ files, handlers }: { files: FileEntry[]; handlers: RowHandlers }) {
  return (
    <ul className="files">
      {files.map((file, i) => (
        <FileRow
          key={file.path}
          file={file}
          depth={0}
          lastChild={i === files.length - 1}
          parentChain={[]}
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

export function Desk({ pinnedFiles, recentFiles, ...handlers }: DeskProps) {
  if (pinnedFiles.length === 0 && recentFiles.length === 0) return null;
  return (
    <div className="desk">
      {pinnedFiles.length > 0 && (
        <div className="desk-group">
          <div className="desk-group__header">
            <span className="desk-group__label">Pinned</span>
            <span className="desk-group__count">{pinnedFiles.length}</span>
          </div>
          <DeskRows files={pinnedFiles} handlers={handlers} />
        </div>
      )}
      {recentFiles.length > 0 && (
        <div className="desk-group">
          <div className="desk-group__header">
            <span className="desk-group__label">Recents</span>
            <span className="desk-group__count">{recentFiles.length}</span>
          </div>
          <DeskRows files={recentFiles} handlers={handlers} />
        </div>
      )}
    </div>
  );
}
