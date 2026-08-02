// Resolving an OS-initiated open to a project root + relative paths.
//
// The tiering is the contract worth pinning: a file already in scope must never
// prompt, and a file nowhere near the user's projects must never silently
// snapshot an arbitrary folder.

import { describe, expect, it } from 'vitest';
import {
  relativeTo,
  resolveOpenTargets
} from '../src/lib/open-external-file';

const PROJECT = '/Users/joe/Notes';
const RECENT = '/Users/joe/Journal';

describe('relativeTo', () => {
  it('returns the project-relative path for a contained file', () => {
    expect(relativeTo(PROJECT, '/Users/joe/Notes/a/b.md')).toBe('a/b.md');
  });

  it('is case-insensitive, matching APFS and NTFS defaults', () => {
    expect(relativeTo('/Users/Joe/notes', '/users/joe/Notes/b.md')).toBe('b.md');
  });

  it('tolerates a trailing separator on the root', () => {
    expect(relativeTo('/Users/joe/Notes/', '/Users/joe/Notes/b.md')).toBe('b.md');
  });

  it('normalizes Windows separators on both sides', () => {
    expect(relativeTo('C:\\Users\\joe\\Notes', 'C:\\Users\\joe\\Notes\\b.md')).toBe(
      'b.md'
    );
  });

  it('rejects a sibling whose name merely starts with the root', () => {
    expect(relativeTo('/Users/joe/Note', '/Users/joe/Notes/b.md')).toBeNull();
  });

  it('rejects a path outside the root, and the root itself', () => {
    expect(relativeTo(PROJECT, '/Users/joe/Other/b.md')).toBeNull();
    expect(relativeTo(PROJECT, PROJECT)).toBeNull();
  });

  it('handles the filesystem root without doubling the separator', () => {
    expect(relativeTo('/', '/b.md')).toBe('b.md');
  });
});

describe('resolveOpenTargets', () => {
  const context = { projectRoot: PROJECT, recentRoots: [RECENT] };

  it('opens a file in the current project without leaving it', () => {
    const result = resolveOpenTargets(['/Users/joe/Notes/a.md'], context);
    expect(result.target).toEqual({
      kind: 'current',
      root: PROJECT,
      relPaths: ['a.md']
    });
    expect(result.deferred).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('switches to a recent project without prompting', () => {
    const result = resolveOpenTargets(['/Users/joe/Journal/2026/x.md'], context);
    expect(result.target).toEqual({
      kind: 'known',
      root: RECENT,
      relPaths: ['2026/x.md']
    });
  });

  it('falls back to the containing folder, flagged for confirmation', () => {
    const result = resolveOpenTargets(['/Users/joe/Downloads/spec.md'], context);
    expect(result.target).toEqual({
      kind: 'new',
      root: '/Users/joe/Downloads',
      relPaths: ['spec.md']
    });
  });

  it('prefers the deepest matching root for a nested project', () => {
    const result = resolveOpenTargets(['/Users/joe/Notes/sub/a.md'], {
      projectRoot: PROJECT,
      recentRoots: ['/Users/joe/Notes/sub']
    });
    expect(result.target).toEqual({
      kind: 'known',
      root: '/Users/joe/Notes/sub',
      relPaths: ['a.md']
    });
  });

  it('keeps the recent root verbatim so it matches what persistence stored', () => {
    const result = resolveOpenTargets(['C:\\Users\\joe\\Journal\\a.md'], {
      projectRoot: null,
      recentRoots: ['C:\\Users\\joe\\Journal']
    });
    expect(result.target?.root).toBe('C:\\Users\\joe\\Journal');
    expect(result.target?.relPaths).toEqual(['a.md']);
  });

  it('derives a new root in the path own separator style', () => {
    const result = resolveOpenTargets(['C:\\Users\\joe\\Downloads\\spec.md'], {
      projectRoot: null,
      recentRoots: []
    });
    expect(result.target?.root).toBe('C:\\Users\\joe\\Downloads');
  });

  it('opens every file that shares the resolved root', () => {
    const result = resolveOpenTargets(
      ['/Users/joe/Notes/a.md', '/Users/joe/Notes/sub/b.txt'],
      context
    );
    expect(result.target?.relPaths).toEqual(['a.md', 'sub/b.txt']);
    expect(result.deferred).toEqual([]);
  });

  it('lets the first path pick the project and defers the rest', () => {
    const result = resolveOpenTargets(
      ['/Users/joe/Notes/a.md', '/Users/joe/Journal/b.md'],
      context
    );
    expect(result.target?.root).toBe(PROJECT);
    expect(result.target?.relPaths).toEqual(['a.md']);
    expect(result.deferred).toEqual(['/Users/joe/Journal/b.md']);
  });

  it('de-duplicates a path listed twice', () => {
    const result = resolveOpenTargets(
      ['/Users/joe/Notes/a.md', '/Users/joe/Notes/a.md'],
      context
    );
    expect(result.target?.relPaths).toEqual(['a.md']);
  });

  it('reports unopenable types instead of dropping them', () => {
    const result = resolveOpenTargets(
      ['/Users/joe/Notes/a.md', '/Users/joe/Notes/image.png'],
      context
    );
    expect(result.target?.relPaths).toEqual(['a.md']);
    expect(result.unsupported).toEqual(['/Users/joe/Notes/image.png']);
  });

  it('returns no target when nothing is openable', () => {
    const result = resolveOpenTargets(['/Users/joe/Notes/image.png'], context);
    expect(result.target).toBeNull();
    expect(result.unsupported).toEqual(['/Users/joe/Notes/image.png']);
  });

  it('accepts every openable document type', () => {
    for (const name of ['a.md', 'a.markdown', 'a.txt', 'a.html', 'a.folio']) {
      const result = resolveOpenTargets([`/Users/joe/Notes/${name}`], context);
      expect(result.target?.relPaths, name).toEqual([name]);
    }
  });

  it('handles an empty input and blank entries', () => {
    expect(resolveOpenTargets([], context).target).toBeNull();
    expect(resolveOpenTargets(['', '  '], context).target).toBeNull();
    expect(resolveOpenTargets(['', '  '], context).unsupported).toEqual([]);
  });

  it('resolves against recents when no project is open', () => {
    const result = resolveOpenTargets(['/Users/joe/Journal/a.md'], {
      projectRoot: null,
      recentRoots: [RECENT]
    });
    expect(result.target?.kind).toBe('known');
  });
});
