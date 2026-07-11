// migrateProjectUiState (SKR-243): every project-state load funnels through
// this before the renderer reads it — the shells store the file opaquely, so
// this is the only place a v1 (tabs-era) file becomes a v2 (working-set) one.

import { describe, expect, it } from 'vitest';
import {
  migrateProjectUiState,
  WORKING_SET_CAP,
  type ProjectUiState,
  type ProjectUiStateV1,
  type TabState
} from '../src/persistence';

function tab(path: string): TabState {
  return {
    path,
    layoutMode: 'split',
    cursor: { line: 1, column: 0 },
    scrollTop: 0,
    splitDividerRatio: 0.5
  };
}

function v1(tabs: TabState[], activeTabIndex: number): ProjectUiStateV1 {
  return {
    schemaVersion: 1,
    projectPath: '/p',
    projectName: 'p',
    lastOpenedMs: 123,
    sidebar: { visible: true, width: 260, pinned: [], sortKey: 'name' },
    tabs,
    activeTabIndex
  };
}

describe('migrateProjectUiState', () => {
  it('passes a v2 state through untouched', () => {
    const state: ProjectUiState = {
      schemaVersion: 2,
      projectPath: '/p',
      projectName: 'p',
      lastOpenedMs: 123,
      sidebar: { visible: true, width: 260 },
      workingSet: [tab('a.md')]
    };
    expect(migrateProjectUiState(state)).toBe(state);
  });

  it('returns null for null (missing file)', () => {
    expect(migrateProjectUiState(null)).toBeNull();
  });

  it('moves the active tab to entry 0, keeping the rest in order', () => {
    const migrated = migrateProjectUiState(
      v1([tab('a.md'), tab('b.md'), tab('c.md')], 1)
    );
    expect(migrated?.schemaVersion).toBe(2);
    expect(migrated?.workingSet.map((e) => e.path)).toEqual([
      'b.md',
      'a.md',
      'c.md'
    ]);
  });

  it('preserves per-entry view state and the sidebar block', () => {
    const entry: TabState = {
      path: 'a.md',
      layoutMode: 'preview',
      cursor: { line: 7, column: 3 },
      scrollTop: 420,
      splitDividerRatio: 0.3
    };
    const source = v1([entry], 0);
    source.sidebar = {
      visible: false,
      width: 300,
      pinned: ['a.md'],
      sortKey: 'modified'
    };
    const migrated = migrateProjectUiState(source);
    expect(migrated?.workingSet[0]).toEqual(entry);
    expect(migrated?.sidebar).toEqual(source.sidebar);
    expect(migrated?.lastOpenedMs).toBe(123);
  });

  it('truncates to the working-set cap', () => {
    const tabs = Array.from({ length: 12 }, (_, i) => tab(`${i}.md`));
    const migrated = migrateProjectUiState(v1(tabs, 5));
    expect(migrated?.workingSet).toHaveLength(WORKING_SET_CAP);
    expect(migrated?.workingSet[0]?.path).toBe('5.md');
  });

  it('keeps file order when activeTabIndex is out of range', () => {
    const migrated = migrateProjectUiState(v1([tab('a.md'), tab('b.md')], -1));
    expect(migrated?.workingSet.map((e) => e.path)).toEqual(['a.md', 'b.md']);
  });

  it('degrades unrecognizable input to null', () => {
    expect(
      migrateProjectUiState({ schemaVersion: 3 } as unknown as ProjectUiState)
    ).toBeNull();
    expect(
      migrateProjectUiState({ schemaVersion: 1 } as unknown as ProjectUiState)
    ).toBeNull();
  });
});
