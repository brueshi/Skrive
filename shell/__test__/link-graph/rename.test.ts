// Rename-with-references parity. Mirrors the Rust port's tests in
// src-tauri/src/project.rs (`rename_with_references_*`,
// `preview_rename_*`). Each test stands up a temp project, populates
// the LinkGraph from disk, runs preview / commit, and checks the
// resulting files + graph state.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extract } from '../../src/lib/link-graph/extract';
import { LinkGraph } from '../../src/lib/link-graph/graph';
import {
  previewRename,
  renameWithReferences,
  type RenameContext
} from '../../src/lib/link-graph/rename';

function setupProject(files: Record<string, string>): RenameContext {
  const root = mkdtempSync(path.join(tmpdir(), 'skrive-rename-'));
  const graph = new LinkGraph();
  const filePaths = new Set<string>();
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    filePaths.add(rel);
    graph.setLinks(rel, extract(body, rel));
  }
  return { root, graph, filePaths };
}

describe('previewRename', () => {
  let ctx: RenameContext;
  afterEach(() => rmSync(ctx.root, { recursive: true, force: true }));

  it('flags target_exists when new path collides on disk', async () => {
    ctx = setupProject({
      'a.md': '# A',
      'b.md': '# B'
    });
    const preview = await previewRename(ctx, 'a.md', 'b.md');
    expect(preview.targetExists).toBe(true);
  });

  it('collects cross-file references with snippet line', async () => {
    ctx = setupProject({
      'index.md': 'See [intro](intro.md).\n',
      'intro.md': '# intro\n'
    });
    const preview = await previewRename(ctx, 'intro.md', 'introduction.md');
    expect(preview.targetExists).toBe(false);
    expect(preview.references.length).toBe(1);
    expect(preview.references[0]!.path).toBe('index.md');
    expect(preview.references[0]!.line).toBe(1);
    expect(preview.references[0]!.snippet).toBe('See [intro](intro.md).');
    expect(preview.definitionUpdates).toEqual([]);
  });

  it('partitions self-references', async () => {
    ctx = setupProject({
      'self.md': 'I link to [me](self.md).\n'
    });
    const preview = await previewRename(ctx, 'self.md', 'renamed.md');
    expect(preview.references).toEqual([]);
    expect(preview.definitionUpdates.length).toBe(1);
    expect(preview.definitionUpdates[0]!.path).toBe('self.md');
  });

  it('picks up wiki-link references', async () => {
    ctx = setupProject({
      'index.md': 'See [[Intro]] for context.\n',
      'intro.md': '# intro\n'
    });
    const preview = await previewRename(ctx, 'intro.md', 'introduction.md');
    expect(preview.references.length).toBe(1);
    expect(preview.references[0]!.kind).toBe('wiki');
  });

  it('picks up reference-style definitions', async () => {
    ctx = setupProject({
      'index.md': 'See [intro][i].\n\n[i]: intro.md\n',
      'intro.md': '# intro\n'
    });
    const preview = await previewRename(ctx, 'intro.md', 'introduction.md');
    // Both the use and the def match. The Rust port returns both;
    // the renamer separates them at commit time.
    expect(preview.references.map((r) => r.kind).sort()).toEqual([
      'referenceDefinition',
      'referenceUse'
    ]);
  });
});

describe('renameWithReferences', () => {
  let ctx: RenameContext;
  afterEach(() => rmSync(ctx.root, { recursive: true, force: true }));

  it('rewrites cross-file inline link', async () => {
    ctx = setupProject({
      'index.md': 'See [intro](intro.md).\n',
      'intro.md': '# intro\n'
    });
    const report = await renameWithReferences(ctx, 'intro.md', 'introduction.md');
    expect(report.referencesUpdated).toBe(1);
    expect(report.filesWritten).toEqual(['index.md']);
    const idx = readFileSync(path.join(ctx.root, 'index.md'), 'utf8');
    expect(idx).toBe('See [intro](introduction.md).\n');
    // Graph state moved.
    expect(ctx.filePaths.has('intro.md')).toBe(false);
    expect(ctx.filePaths.has('introduction.md')).toBe(true);
  });

  it('rewrites reference definitions but leaves uses alone', async () => {
    ctx = setupProject({
      'index.md': 'See [intro][i].\n\n[i]: intro.md\n',
      'intro.md': '# intro\n'
    });
    const report = await renameWithReferences(ctx, 'intro.md', 'introduction.md');
    expect(report.referencesUpdated).toBe(1);
    const idx = readFileSync(path.join(ctx.root, 'index.md'), 'utf8');
    expect(idx).toBe('See [intro][i].\n\n[i]: introduction.md\n');
  });

  it('wiki-link rewrite uses the new file stem', async () => {
    ctx = setupProject({
      'index.md': 'See [[Intro]] for context.\n',
      'intro.md': '# intro\n'
    });
    await renameWithReferences(ctx, 'intro.md', 'introduction.md');
    const idx = readFileSync(path.join(ctx.root, 'index.md'), 'utf8');
    expect(idx).toBe('See [[introduction]] for context.\n');
  });

  it('rewrites self-reference at the new path', async () => {
    ctx = setupProject({
      'self.md': 'I link to [me](self.md).\n'
    });
    const report = await renameWithReferences(ctx, 'self.md', 'renamed.md');
    expect(report.referencesUpdated).toBe(1);
    const renamed = readFileSync(path.join(ctx.root, 'renamed.md'), 'utf8');
    expect(renamed).toBe('I link to [me](renamed.md).\n');
  });

  it('throws when target already exists', async () => {
    ctx = setupProject({
      'a.md': '# A',
      'b.md': '# B'
    });
    await expect(
      renameWithReferences(ctx, 'a.md', 'b.md')
    ).rejects.toThrow(/already exists/);
  });

  it('moves the graph entry even when the renamed file has no self-edits', async () => {
    ctx = setupProject({
      'index.md': 'See [intro](intro.md).\n',
      'intro.md': '# intro with no outgoing\n'
    });
    await renameWithReferences(ctx, 'intro.md', 'introduction.md');
    expect(ctx.graph.outgoing('intro.md')).toBeUndefined();
    expect(ctx.graph.outgoing('introduction.md')).toBeDefined();
  });
});
