// Pure geometry + tree-building helpers for the sidebar. No React state,
// no store access — just the shape of the "All" tree and the spine-rule
// indent guides from the v0.1.5 redesign.
//
// Spine rule (non-canonical, the user's IP — see memory):
//   At each row, the set of spine columns drawn comes from its
//   ancestor-lastness chain. A spine at column d is drawn iff the
//   ancestor at depth (d+1) is NOT a last child. That keeps each
//   subtree's spine confined to its own siblings — when an ancestor
//   is a last child, its column-line stops at its own elbow rather
//   than extending through descendants.

import type { CSSProperties } from 'react';
import type { FileEntry, SidebarSortKey } from '@skrive/shared';

export type FileCompare = (a: FileEntry, b: FileEntry) => number;

// Comparator for the "All" tree's files. Folders always stay alphabetical
// (a folder has no meaningful modified/created stamp of its own).
export function fileComparator(sortKey: SidebarSortKey): FileCompare {
  switch (sortKey) {
    case 'modified':
      return (a, b) =>
        (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) ||
        a.name.localeCompare(b.name);
    case 'created':
      // createdMs lands with the native scanner (Zig core) in SKR-138 —
      // until then this falls back to modified time, and the sort menu
      // doesn't yet offer the option.
      return (a, b) =>
        (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) ||
        a.name.localeCompare(b.name);
    case 'name':
    default:
      return (a, b) => a.name.localeCompare(b.name);
  }
}

export type TreeFolder = {
  name: string;
  path: string;
  folders: TreeFolder[];
  files: FileEntry[];
};

export function projectName(root: string | null | undefined): string {
  if (!root) return '';
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

export function buildTree(
  files: FileEntry[],
  fileCompare: FileCompare
): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], files: [] };
  const byPath = new Map<string, TreeFolder>();
  byPath.set('', root);

  for (const f of files) {
    const lastSep = f.path.lastIndexOf('/');
    if (lastSep === -1) {
      root.files.push(f);
      continue;
    }
    const parts = f.path.slice(0, lastSep).split('/');
    let parent = root;
    let runningPath = '';
    for (const part of parts) {
      runningPath = runningPath ? `${runningPath}/${part}` : part;
      let next = byPath.get(runningPath);
      if (!next) {
        next = { name: part, path: runningPath, folders: [], files: [] };
        parent.folders.push(next);
        byPath.set(runningPath, next);
      }
      parent = next;
    }
    parent.files.push(f);
  }

  const sortFolder = (folder: TreeFolder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort(fileCompare);
    folder.folders.forEach(sortFolder);
  };
  sortFolder(root);

  return root;
}

export function buildSpineStyle(
  spineDepths: number[],
  depth: number
): CSSProperties {
  const base = { '--sb-depth': depth } as CSSProperties;
  if (spineDepths.length === 0) return base;
  const stripe =
    'linear-gradient(to right, var(--skrive-rule) 0, var(--skrive-rule) 1px, transparent 1px)';
  const images = spineDepths.map(() => stripe).join(', ');
  const positions = spineDepths
    .map((d) => `calc(1rem + ${d} * var(--sb-indent-step)) 0`)
    .join(', ');
  const sizes = spineDepths.map(() => '1px 100%').join(', ');
  const repeats = spineDepths.map(() => 'no-repeat').join(', ');
  return {
    ...base,
    backgroundImage: images,
    backgroundPosition: positions,
    backgroundSize: sizes,
    backgroundRepeat: repeats
  } as CSSProperties;
}

export function spineFromChain(
  parentChain: boolean[],
  lastChild: boolean,
  depth: number
): number[] {
  if (depth === 0) return [];
  const chain = [...parentChain, lastChild];
  return chain.map((isLast, i) => (isLast ? -1 : i)).filter((d) => d >= 0);
}
