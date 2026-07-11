// ⌘P file switcher. Same shell as CommandPalette; haystack is the
// project manifest's markdown files, with an LRU of recent files
// floated to the top when the query is empty.
//
// Cmdk's built-in fuzzy filter handles ranking. We feed it a flat
// list of `{ path, leaf }` rows; cmdk filters against each row's
// `value` (path) so leaf-first matches still rank well — most
// scoring frameworks weight prefix and segment-boundary hits.

import { Command as Cmd } from 'cmdk';
import { useEffect, useState } from 'react';
import type { FileEntry } from '@skrive/shared';
import { CommandModal } from './CommandModal';
import { logProjectError, useProjectStore } from '../../stores/project';
import { usePreferencesStore } from '../../stores/preferences';
import { notify } from '../../lib/notify';

type Props = {
  open: boolean;
  onClose: () => void;
};

const RECENT_DISPLAY_CAP = 8;

function leafName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function FileSwitcher({ open, onClose }: Props) {
  const manifest = useProjectStore((s) => s.manifest);
  const openDoc = useProjectStore((s) => s.openDoc);
  const recentFiles = usePreferencesStore((s) => s.recentFiles);

  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (!manifest) return null;

  // The "recent" section is only meaningful with an empty query —
  // when the user types, cmdk's filter does the work and the LRU
  // just becomes ranking input.
  const recentForProject = recentFiles
    .filter((r) => r.projectPath === manifest.root)
    .filter((r) => manifest.files.some((f) => f.path === r.filePath))
    .slice(0, RECENT_DISPLAY_CAP);

  const showingRecent = query.trim().length === 0 && recentForProject.length > 0;
  const recentSet = new Set(recentForProject.map((r) => r.filePath));

  const allFiles: FileEntry[] = manifest.files;

  function handleSelect(path: string) {
    onClose();
    void openDoc(path).catch((err) => {
      logProjectError('openDoc (switcher)', err);
      notify.error(`Couldn't open ${path}`, err);
    });
  }

  return (
    <CommandModal
      open={open}
      onClose={onClose}
      ariaLabel="Open file"
      placeholder="Open file…"
      query={query}
      onQueryChange={setQuery}
      emptyState={<span>No matching files.</span>}
    >
      {showingRecent && (
        <Cmd.Group heading="Recent" className="cmdk-group">
          {recentForProject.map((r) => (
            <Cmd.Item
              key={`recent:${r.filePath}`}
              value={r.filePath}
              onSelect={() => handleSelect(r.filePath)}
              className="cmdk-item cmdk-file-row"
            >
              <span className="cmdk-file-leaf">{leafName(r.filePath)}</span>
              <span className="cmdk-file-dir">{dirOf(r.filePath)}</span>
            </Cmd.Item>
          ))}
        </Cmd.Group>
      )}
      <Cmd.Group
        heading={showingRecent ? 'All files' : undefined}
        className="cmdk-group"
      >
        {allFiles.map((f) => {
          // While showing recent, hide entries that already appear up
          // top so the user doesn't see them twice.
          if (showingRecent && recentSet.has(f.path)) return null;
          return (
            <Cmd.Item
              key={f.path}
              value={f.path}
              onSelect={() => handleSelect(f.path)}
              className="cmdk-item cmdk-file-row"
            >
              <span className="cmdk-file-leaf">{leafName(f.path)}</span>
              <span className="cmdk-file-dir">{dirOf(f.path)}</span>
            </Cmd.Item>
          );
        })}
      </Cmd.Group>
    </CommandModal>
  );
}
