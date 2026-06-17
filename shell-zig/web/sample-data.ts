// Canned read-only project for the Stage 1 spike. Everything the Zig core
// does not yet implement is answered from this data, so the full Skrive UI
// renders and a sample document opens — without any disk access. The
// bodies mirror shell-zig/fixtures/sample-project verbatim.
//
// This file imports only value-level constants from `shared` (the default
// UI state); the rest is plain data. It is bundled into the injected
// native bridge, never shipped in the Electron product.

import { DEFAULT_APP_UI_STATE } from '../../shared/src/persistence';
import type { AppUiState, ProjectUiState } from '../../shared/src/persistence';
import type {
  FileContent,
  ProjectSnapshot
} from '../../shared/src/ipc-contracts';
// The typography specimen is authored once on disk (Electron opens that
// folder directly) and inlined here at bundle time, so the spike and the
// Electron build render byte-identical input for the 1.3 gate.
import typographyMd from '../fixtures/typography-sample/typography.md' with { type: 'text' };

/** Fake absolute root. Never touched on disk — `fs:*` is fully canned. */
export const SAMPLE_ROOT = '/Skrive/Parity Sample';

/** Commands the Zig core implements for real in Stage 1. Everything else
 *  is served from the canned data below. Stage 2 migrates commands out of
 *  the mock by adding them here. */
export const NATIVE_COMMANDS = new Set<string>(['app:version', 'diag:poison']);

const BODIES: Record<string, string> = {
  'typography.md': typographyMd,
  'README.md':
    '# Parity Sample\n\nA tiny project the parity corpus runs against. See [intro](notes/intro.md).\n',
  'notes/intro.md':
    '---\ntitle: Intro\ntags: [sample, parity]\n---\n\nBack to [readme](../README.md). This is a [dead](missing.md) link and a\n[[Wiki]] reference, so the snapshot has frontmatter and edges to derive.\n',
  '.skrive.toml': '[project]\nname = "Parity Sample"\n'
};

// Placeholder hex digests. The read-only spike never verifies them
// (external-change detection only runs before a save), so any well-formed
// 64-char hex is inert here. Stage 2's real core computes true SHA-256.
const HASHES: Record<string, string> = {
  'typography.md':
    '4444444444444444444444444444444444444444444444444444444444444444',
  'README.md':
    '1111111111111111111111111111111111111111111111111111111111111111',
  'notes/intro.md':
    '2222222222222222222222222222222222222222222222222222222222222222',
  '.skrive.toml':
    '3333333333333333333333333333333333333333333333333333333333333333'
};

const MODIFIED_MS = 1_718_000_000_000;

export function sampleAppState(): AppUiState {
  return {
    ...DEFAULT_APP_UI_STATE,
    // Auto-open the sample on boot (App.tsx restores lastOpenedProject).
    lastOpenedProject: SAMPLE_ROOT,
    // Non-null so the preferences store never schedules a save on boot.
    firstRunMs: MODIFIED_MS,
    recentProjects: [
      { path: SAMPLE_ROOT, name: 'Parity Sample', lastOpenedMs: MODIFIED_MS }
    ]
  };
}

export function sampleProjectState(): ProjectUiState {
  return {
    schemaVersion: 1,
    projectPath: SAMPLE_ROOT,
    projectName: 'Parity Sample',
    lastOpenedMs: MODIFIED_MS,
    sidebar: { visible: true, width: 260 },
    // Open the typography specimen on launch — it is the 1.3 comparison
    // doc. README stays in the tree for context.
    tabs: [
      {
        path: 'typography.md',
        layoutMode: 'preview',
        cursor: { line: 1, column: 0 },
        scrollTop: 0,
        splitDividerRatio: 0.5
      }
    ],
    activeTabIndex: 0
  };
}

export function sampleSnapshot(): ProjectSnapshot {
  const textFiles = Object.keys(BODIES).map((path) => ({
    path,
    body: BODIES[path],
    modifiedMs: MODIFIED_MS,
    hash: HASHES[path],
    sizeBytes: new TextEncoder().encode(BODIES[path]).length
  }));
  // Binary asset: listed with body null; the renderer fetches it through
  // the asset origin (skrive-asset://). This is the 1.2 cross-origin /
  // mixed-content probe target.
  const asset = {
    path: 'test.png',
    body: null,
    modifiedMs: MODIFIED_MS,
    hash: null,
    sizeBytes: 74
  };
  return { root: SAMPLE_ROOT, files: [...textFiles, asset] };
}

/** Payload-aware `fs:readFile`: the mock transport keys only on command
 *  name, so reads are special-cased here to return the right body and let
 *  the writer click between the sample's documents. */
export function sampleFileContent(relPath: string): FileContent {
  const body = BODIES[relPath] ?? '';
  return {
    path: relPath,
    body,
    modifiedMs: MODIFIED_MS,
    hash:
      HASHES[relPath] ??
      '0000000000000000000000000000000000000000000000000000000000000000'
  };
}
