// A single document row in the sidebar (used by both the flat special
// groups and the recursive folder tree). Owns its own right-click context
// menu: pin, rename, export/convert, delete.

import { useMemo, type KeyboardEvent } from 'react';
import type { FileEntry } from '@skrive/shared';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { selectLiveDocPath, useProjectStore } from '../../stores/project';
import { resolveTitle } from '../../lib/title';
import { fileMode } from '../../stores/save';
import { EXPORT_FORMATS, type ExportFormatId } from '../../lib/export';
import { importKind } from '../../lib/import';
import { DocIcon } from '../icons/DocIcon';
import { IconStar } from '../icons/IconStar';
import { buildSpineStyle, spineFromChain } from './tree';

export type FileRowProps = {
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

export function FileRow({
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
