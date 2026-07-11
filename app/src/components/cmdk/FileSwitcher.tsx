// ⌘P file switcher. Same shell as CommandPalette; haystack is the
// project manifest's files.
//
// Empty query (SKR-243): the working set — the same array the summon fan
// and (Stage 2) the sidebar desk render, so the lists can never diverge —
// then pinned documents, then everything else. The live doc leads but is
// disabled, so the first *selectable* row is the previous document and
// ⌘P ⏎ = "back to the last doc" (the Obsidian pattern).
//
// Typed query: cmdk's built-in fuzzy filter ranks the whole library. We
// feed it flat `{ path, leaf }` rows; cmdk filters against each row's
// `value` (path) so leaf-first matches still rank well — most scoring
// frameworks weight prefix and segment-boundary hits.

import { Command as Cmd } from 'cmdk';
import { useEffect, useState } from 'react';
import type { FileEntry } from '@skrive/shared';
import { CommandModal } from './CommandModal';
import { logProjectError, useProjectStore } from '../../stores/project';
import { notify } from '../../lib/notify';

type Props = {
  open: boolean;
  onClose: () => void;
};

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
  const liveDoc = useProjectStore((s) => s.liveDoc);
  const workingSet = useProjectStore((s) => s.workingSet);
  const pinned = useProjectStore((s) => s.pinned);

  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (!manifest) return null;

  const exists = (p: string) => manifest.files.some((f) => f.path === p);

  // The curated sections only render on an empty query — once the user
  // types, cmdk's filter does the work over the flat library.
  const workingRows = workingSet.filter((e) => exists(e.path));
  const workingPaths = new Set(workingRows.map((e) => e.path));
  const pinnedRows = pinned.filter((p) => exists(p) && !workingPaths.has(p));
  const curated = query.trim().length === 0 && workingRows.length > 0;
  const curatedPaths = new Set([...workingPaths, ...pinnedRows]);

  const allFiles: FileEntry[] = manifest.files;

  function handleSelect(path: string) {
    onClose();
    void openDoc(path).catch((err) => {
      logProjectError('openDoc (switcher)', err);
      notify.error(`Couldn't open ${path}`, err);
    });
  }

  function fileRow(path: string, keyPrefix = '', current = false) {
    return (
      <Cmd.Item
        key={`${keyPrefix}${path}`}
        value={path}
        disabled={current}
        onSelect={() => handleSelect(path)}
        className={`cmdk-item cmdk-file-row${current ? ' cmdk-current' : ''}`}
      >
        <span className="cmdk-file-leaf">{leafName(path)}</span>
        <span className="cmdk-file-dir">
          {current ? 'current' : dirOf(path)}
        </span>
      </Cmd.Item>
    );
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
      {curated && (
        <Cmd.Group heading="Recent" className="cmdk-group">
          {workingRows.map((entry) =>
            fileRow(entry.path, 'ws:', entry.path === liveDoc?.path)
          )}
        </Cmd.Group>
      )}
      {curated && pinnedRows.length > 0 && (
        <Cmd.Group heading="Pinned" className="cmdk-group">
          {pinnedRows.map((path) => fileRow(path, 'pin:'))}
        </Cmd.Group>
      )}
      <Cmd.Group
        heading={curated ? 'All files' : undefined}
        className="cmdk-group"
      >
        {allFiles.map((f) => {
          // While showing the curated sections, hide entries that already
          // appear up top so the user doesn't see them twice.
          if (curated && curatedPaths.has(f.path)) return null;
          return fileRow(f.path);
        })}
      </Cmd.Group>
    </CommandModal>
  );
}
