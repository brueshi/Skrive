// Persistence module tests. Cover hash determinism, atomic-write
// semantics, defaults-on-missing, schema migration passthrough on v1,
// and unknown-future-version fallback.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_APP_UI_STATE,
  defaultProjectUiState,
  type AppUiState,
  type ProjectUiState
} from '@skrive/shared';
import {
  appStateFile,
  hashProjectPath,
  loadAppState,
  loadProjectState,
  migrateAppState,
  migrateProjectState,
  projectStateFile,
  saveAppState,
  saveProjectState
} from '../src/lib/persistence';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'skrive-persistence-'));
  tempDirs.push(dir);
  return dir;
}

describe('hashProjectPath', () => {
  it('is deterministic for the same input', () => {
    const a = hashProjectPath('/Users/jane/notes');
    const b = hashProjectPath('/Users/jane/notes');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('differs for different paths', () => {
    expect(hashProjectPath('/a')).not.toBe(hashProjectPath('/b'));
  });
});

describe('appState file resolution', () => {
  it('points at app.json under userData', () => {
    const dir = '/tmp/userData';
    expect(appStateFile(dir)).toBe(path.join(dir, 'app.json'));
  });

  it('places project state under projects/ with the hash filename', () => {
    const dir = '/tmp/userData';
    const file = projectStateFile(dir, '/Users/jane/notes');
    expect(path.dirname(file)).toBe(path.join(dir, 'projects'));
    expect(path.basename(file)).toBe(`${hashProjectPath('/Users/jane/notes')}.json`);
  });
});

describe('loadAppState / saveAppState', () => {
  it('returns defaults when app.json is missing', async () => {
    const dir = makeTempDir();
    const state = await loadAppState(dir);
    expect(state.schemaVersion).toBe(1);
    expect(state.recentProjects).toEqual([]);
    expect(state.editorFont).toBe(DEFAULT_APP_UI_STATE.editorFont);
  });

  it('round-trips through disk', async () => {
    const dir = makeTempDir();
    const state: AppUiState = {
      ...DEFAULT_APP_UI_STATE,
      lastOpenedProject: '/tmp/example',
      recentProjects: [
        { path: '/tmp/example', name: 'example', lastOpenedMs: 12345 }
      ],
      personalDictionary: ['Skrive', 'atticus'],
      editorFont: 'classic',
      editorFontSize: 18
    };
    await saveAppState(dir, state);
    const loaded = await loadAppState(dir);
    expect(loaded).toEqual(state);
  });

  it('returns defaults when the file is corrupt JSON', async () => {
    const dir = makeTempDir();
    await fs.writeFile(appStateFile(dir), '{not valid json', 'utf8');
    const state = await loadAppState(dir);
    expect(state.schemaVersion).toBe(1);
    expect(state.recentProjects).toEqual([]);
  });

  it('does not leave a stale .tmp behind on success', async () => {
    const dir = makeTempDir();
    await saveAppState(dir, DEFAULT_APP_UI_STATE);
    const tmpExists = await fs
      .stat(`${appStateFile(dir)}.tmp`)
      .then(
        () => true,
        () => false
      );
    expect(tmpExists).toBe(false);
  });
});

describe('loadProjectState / saveProjectState', () => {
  it('returns null when the project has never been opened', async () => {
    const dir = makeTempDir();
    const result = await loadProjectState(dir, '/tmp/nope');
    expect(result).toBeNull();
  });

  it('round-trips a project state through disk', async () => {
    const dir = makeTempDir();
    const project = '/tmp/round-trip';
    const state: ProjectUiState = {
      schemaVersion: 1,
      projectPath: project,
      projectName: 'round-trip',
      lastOpenedMs: 1_700_000_000_000,
      sidebar: { visible: true, width: 280 },
      tabs: [
        {
          path: 'intro.md',
          layoutMode: 'split',
          cursor: { line: 12, column: 4 },
          scrollTop: 100,
          splitDividerRatio: 0.45
        }
      ],
      activeTabIndex: 0
    };
    await saveProjectState(dir, project, state);
    const loaded = await loadProjectState(dir, project);
    expect(loaded).toEqual(state);
  });
});

describe('migrateAppState', () => {
  it('passes through a complete v1 file unchanged', () => {
    const input = {
      schemaVersion: 1,
      lastOpenedProject: '/x',
      recentProjects: [{ path: '/x', name: 'x', lastOpenedMs: 1 }],
      license: null,
      firstRunMs: null,
      personalDictionary: ['a'],
      skipDeleteConfirmation: true,
      recentFiles: [],
      editorFont: 'sans',
      editorCustomFontFamily: '',
      editorFontSize: 18,
      editorLineHeightX100: 200,
      autoUpdateOnLaunch: false
    };
    const out = migrateAppState(input);
    expect(out.lastOpenedProject).toBe('/x');
    expect(out.skipDeleteConfirmation).toBe(true);
    expect(out.editorFont).toBe('sans');
    expect(out.autoUpdateOnLaunch).toBe(false);
  });

  it('fills in missing fields from a partial older v1 file', () => {
    const out = migrateAppState({
      schemaVersion: 1,
      personalDictionary: ['x']
    });
    expect(out.personalDictionary).toEqual(['x']);
    expect(out.editorFont).toBe(DEFAULT_APP_UI_STATE.editorFont);
    expect(out.editorFontSize).toBe(DEFAULT_APP_UI_STATE.editorFontSize);
    expect(out.recentProjects).toEqual([]);
    // A file written before surface switching existed has no flag; it must
    // default to enabled rather than locking the writer out of switching.
    expect(out.surfaceSwitchingEnabled).toBe(true);
  });

  it('defaults the feedback-nudge fields and preserves valid stored values', () => {
    // Absent (older file): fall back to the launch-counter / seen defaults.
    const fresh = migrateAppState({ schemaVersion: 1 });
    expect(fresh.launchCount).toBe(DEFAULT_APP_UI_STATE.launchCount);
    expect(fresh.seenFeedbackPrompt).toBe(
      DEFAULT_APP_UI_STATE.seenFeedbackPrompt
    );
    // Valid stored values round-trip; a fractional count is rounded.
    const stored = migrateAppState({
      schemaVersion: 1,
      launchCount: 4.7,
      seenFeedbackPrompt: true
    });
    expect(stored.launchCount).toBe(5);
    expect(stored.seenFeedbackPrompt).toBe(true);
    // Malformed values are dropped rather than leaking through.
    const bogus = migrateAppState({
      schemaVersion: 1,
      launchCount: 'lots',
      seenFeedbackPrompt: 'yes'
    });
    expect(bogus.launchCount).toBe(DEFAULT_APP_UI_STATE.launchCount);
    expect(bogus.seenFeedbackPrompt).toBe(
      DEFAULT_APP_UI_STATE.seenFeedbackPrompt
    );
  });

  it('preserves an explicit surfaceSwitchingEnabled: false', () => {
    const out = migrateAppState({
      schemaVersion: 1,
      surfaceSwitchingEnabled: false
    });
    expect(out.surfaceSwitchingEnabled).toBe(false);
  });

  it('defaults markerMode to recessed and preserves a valid stored value', () => {
    expect(migrateAppState({ schemaVersion: 1 }).markerMode).toBe('recessed');
    expect(
      migrateAppState({ schemaVersion: 1, markerMode: 'concealed' }).markerMode
    ).toBe('concealed');
    // A bogus value falls back to the default rather than leaking through.
    expect(
      migrateAppState({ schemaVersion: 1, markerMode: 'sideways' }).markerMode
    ).toBe('recessed');
  });

  it('falls back to defaults when schemaVersion is from the future', () => {
    const out = migrateAppState({
      schemaVersion: 99,
      lastOpenedProject: '/should-be-ignored'
    });
    expect(out).toEqual({
      ...DEFAULT_APP_UI_STATE,
      recentProjects: [],
      personalDictionary: [],
      recentFiles: []
    });
  });

  it('drops malformed recentProjects entries', () => {
    const out = migrateAppState({
      schemaVersion: 1,
      recentProjects: [
        { path: '/ok', name: 'ok', lastOpenedMs: 1 },
        { path: 42 },
        null
      ]
    });
    expect(out.recentProjects).toEqual([
      { path: '/ok', name: 'ok', lastOpenedMs: 1 }
    ]);
  });
});

describe('migrateProjectState', () => {
  it('clamps activeTabIndex within bounds', () => {
    const out = migrateProjectState(
      {
        schemaVersion: 1,
        projectPath: '/p',
        projectName: 'p',
        lastOpenedMs: 0,
        sidebar: { visible: true, width: 260 },
        tabs: [],
        activeTabIndex: 99
      },
      '/p'
    );
    expect(out.activeTabIndex).toBe(-1);
  });

  it('drops tab entries with no path', () => {
    const out = migrateProjectState(
      {
        schemaVersion: 1,
        projectPath: '/p',
        projectName: 'p',
        lastOpenedMs: 0,
        sidebar: { visible: true, width: 260 },
        tabs: [{ path: 'a.md', layoutMode: 'raw' }, { layoutMode: 'split' }],
        activeTabIndex: 0
      },
      '/p'
    );
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0]!.path).toBe('a.md');
  });

  it('falls back to defaults when input is malformed', () => {
    const out = migrateProjectState('garbage', '/canonical');
    expect(out).toEqual(defaultProjectUiState('/canonical', ''));
  });
});
