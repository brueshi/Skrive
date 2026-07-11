// ⌘P file switcher. Same shell as CommandPalette; haystack is the
// project manifest's files.
//
// Rows speak the fan's language (SKR-243): doc icon, display name
// (`.folio` stripped, `.md` kept — the front-title rule), dimmed parent
// folder on the right. Not the mono path voice — the switcher lists
// documents, not files; typing still matches against the full path.
//
// Empty query: the working set — the same array the summon fan and
// (Stage 2) the sidebar desk render, so the lists can never diverge —
// then pinned documents, then everything else. The live doc leads but is
// disabled, so the first *selectable* row is the previous document and
// ⌘P ⏎ = "back to the last doc" (the Obsidian pattern).

import { Command as Cmd } from 'cmdk';
import { useEffect, useState } from 'react';
import type { FileEntry } from '@skrive/shared';
import { CommandModal } from './CommandModal';
import { logProjectError, useProjectStore } from '../../stores/project';
import { DocIcon } from '../icons/DocIcon';
import { stripFolioExtension } from '../../lib/title';
import { notify } from '../../lib/notify';

type Props = {
  open: boolean;
  onClose: () => void;
};

function displayName(p: string): string {
  const i = p.lastIndexOf('/');
  return stripFolioExtension(i === -1 ? p : p.slice(i + 1));
}

/** The dimmed origin hint: the parent folder's own name, not the full
 *  path — enough to disambiguate without reading as a filesystem. */
function parentName(p: string): string {
  const i = p.lastIndexOf('/');
  if (i === -1) return '';
  const dir = p.slice(0, i);
  const j = dir.lastIndexOf('/');
  return j === -1 ? dir : dir.slice(j + 1);
}

type DocRowProps = {
  path: string;
  current?: boolean;
  onSelect: (path: string) => void;
};

function DocRow({ path, current = false, onSelect }: DocRowProps) {
  return (
    <Cmd.Item
      value={path}
      disabled={current}
      onSelect={() => onSelect(path)}
      className={`cmdk-item cmdk-doc-row${current ? ' cmdk-current' : ''}`}
    >
      <span className="cmdk-doc-glyph" aria-hidden="true">
        <DocIcon path={path} size={16} />
      </span>
      <span className="cmdk-doc-name">{displayName(path)}</span>
      <span className="cmdk-doc-where">
        {current ? 'current' : parentName(path)}
      </span>
    </Cmd.Item>
  );
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
  const curated =
    query.trim().length === 0 &&
    (workingRows.length > 0 || pinnedRows.length > 0);
  const curatedPaths = new Set([...workingPaths, ...pinnedRows]);

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
      {curated && workingRows.length > 0 && (
        <Cmd.Group heading="Recent" className="cmdk-group">
          {workingRows.map((entry) => (
            <DocRow
              key={`ws:${entry.path}`}
              path={entry.path}
              current={entry.path === liveDoc?.path}
              onSelect={handleSelect}
            />
          ))}
        </Cmd.Group>
      )}
      {curated && pinnedRows.length > 0 && (
        <Cmd.Group heading="Pinned" className="cmdk-group">
          {pinnedRows.map((path) => (
            <DocRow key={`pin:${path}`} path={path} onSelect={handleSelect} />
          ))}
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
          return <DocRow key={f.path} path={f.path} onSelect={handleSelect} />;
        })}
      </Cmd.Group>
    </CommandModal>
  );
}
