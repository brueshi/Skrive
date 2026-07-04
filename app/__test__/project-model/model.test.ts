// ProjectModel tests (Stage 0.4). Carries forward the contracts the
// shell suites enforced before the move:
//   - manifest version bumps ONLY on structure-relevant changes
//     (ported from shell/__test__/project/manifest.test.ts)
//   - rename planning semantics (adapted from
//     shell/__test__/link-graph/rename.test.ts, pure planning instead
//     of disk application)
//   - search semantics (shell/src/ipc/search.ts behavior)

import { describe, expect, it } from 'vitest';
import type { ProjectSnapshot, SnapshotFile } from '@skrive/shared';
import { ProjectModel } from '../../src/lib/project-model/model';

function file(path: string, body: string | null): SnapshotFile {
  return {
    path,
    body,
    modifiedMs: 1_700_000_000_000,
    hash: body === null ? null : 'h',
    sizeBytes: body?.length ?? 0
  };
}

function snapshot(files: SnapshotFile[]): ProjectSnapshot {
  return { root: '/p', files };
}

function makeModel(files: SnapshotFile[]): ProjectModel {
  const model = new ProjectModel();
  model.init(snapshot(files));
  return model;
}

describe('manifest derivation', () => {
  it('builds sorted entries with frontmatter, schema, and config', () => {
    const model = makeModel([
      file('b.md', '---\ntitle: B\n---\nbody'),
      file('a.md', '# A'),
      file('LICENSE', null),
      file('.skrive.toml', '[project]\nname = "Proj"\n')
    ]);
    const manifest = model.manifest();

    expect(manifest.root).toBe('/p');
    expect(manifest.files.map((f) => f.path)).toEqual(['a.md', 'b.md']);
    expect(manifest.files[1]!.frontmatter).toEqual({ title: 'B' });
    expect(manifest.schema.fields['title']).toBeDefined();
    expect(manifest.config.project.name).toBe('Proj');
    expect(manifest.warnings).toEqual([]);
    expect(model.currentVersion()).toBe(1);
  });

  it('does not bump the version on a content-only edit', () => {
    const model = makeModel([file('a.md', '---\nt: 1\n---\nold')]);
    const bumped = model.upsert('a.md', '---\nt: 1\n---\nnew body');
    expect(bumped).toBe(false);
    expect(model.currentVersion()).toBe(1);
  });

  it('bumps on frontmatter change, new path, and removal', () => {
    const model = makeModel([file('a.md', '---\nt: 1\n---\nx')]);

    expect(model.upsert('a.md', '---\nt: 2\n---\nx')).toBe(true);
    expect(model.currentVersion()).toBe(2);

    expect(model.upsert('new.md', 'fresh')).toBe(true);
    expect(model.currentVersion()).toBe(3);
    expect(model.manifest().files.map((f) => f.path)).toEqual([
      'a.md',
      'new.md'
    ]);

    expect(model.remove('new.md')).toBe(true);
    expect(model.currentVersion()).toBe(4);
  });

  it('lists native .folio documents in the manifest (so they open + show)', () => {
    // A .folio is listed with a null body in the snapshot, like an asset — but
    // unlike an asset it is an openable document and must appear in the manifest.
    const model = makeModel([
      file('notes.md', '# Notes'),
      file('doc.folio', null),
      file('logo.png', null)
    ]);
    const files = model.manifest().files.map((f) => f.path);
    expect(files).toContain('doc.folio');
    expect(files).not.toContain('logo.png'); // a true asset stays out
    // No Markdown frontmatter is invented for it.
    expect(model.manifest().files.find((f) => f.path === 'doc.folio')!.frontmatter).toEqual({});
  });

  it('adds a new .folio on upsert (bumps) and does not churn on re-save', () => {
    const model = makeModel([file('a.md', 'x')]);
    expect(model.upsert('doc.folio', '')).toBe(true); // new document -> shows up
    expect(model.currentVersion()).toBe(2);
    expect(model.manifest().files.map((f) => f.path)).toEqual(['a.md', 'doc.folio']);
    // A content re-save of the folio carries no manifest-relevant change.
    expect(model.upsert('doc.folio', '')).toBe(false);
    expect(model.currentVersion()).toBe(2);
    // Removal drops the entry and bumps.
    expect(model.remove('doc.folio')).toBe(true);
    expect(model.currentVersion()).toBe(3);
    expect(model.manifest().files.map((f) => f.path)).toEqual(['a.md']);
  });

  it('lists plain-text files in the manifest (so they open + show)', () => {
    // SKR-204: a `.txt` is an openable non-Markdown file — it surfaces in the
    // sidebar like a `.folio`, but a true asset (image) stays out.
    const model = makeModel([
      file('notes.md', '# Notes'),
      file('log.txt', 'plain contents'),
      file('logo.png', null)
    ]);
    const files = model.manifest().files.map((f) => f.path);
    expect(files).toContain('log.txt');
    expect(files).not.toContain('logo.png');
    // No Markdown frontmatter is invented, even if the text starts with `---`.
    expect(model.manifest().files.find((f) => f.path === 'log.txt')!.frontmatter).toEqual({});
  });

  it('adds a new .txt on upsert (bumps) and does not churn on re-save', () => {
    const model = makeModel([file('a.md', 'x')]);
    expect(model.upsert('log.txt', 'hello')).toBe(true); // new file -> shows up
    expect(model.currentVersion()).toBe(2);
    expect(model.manifest().files.map((f) => f.path)).toEqual(['a.md', 'log.txt']);
    // A content re-save carries no manifest-relevant change (no frontmatter).
    expect(model.upsert('log.txt', 'hello world')).toBe(false);
    expect(model.currentVersion()).toBe(2);
    expect(model.remove('log.txt')).toBe(true);
    expect(model.currentVersion()).toBe(3);
    expect(model.manifest().files.map((f) => f.path)).toEqual(['a.md']);
  });

  it('lists HTML files in the manifest (so they open in the viewer + show)', () => {
    // SKR-205: `.html` / `.htm` are openable non-Markdown files — they surface in
    // the sidebar like a `.folio` and open in the read-only viewer, but a true
    // asset stays out. No Markdown frontmatter is invented.
    const model = makeModel([
      file('notes.md', '# Notes'),
      file('page.html', '<h1>Hi</h1>'),
      file('legacy.htm', '<p>Old</p>'),
      file('logo.png', null)
    ]);
    const files = model.manifest().files.map((f) => f.path);
    expect(files).toContain('page.html');
    expect(files).toContain('legacy.htm');
    expect(files).not.toContain('logo.png');
    expect(model.manifest().files.find((f) => f.path === 'page.html')!.frontmatter).toEqual({});
  });

  it('adds a new .html on upsert (bumps) and does not churn on re-save', () => {
    const model = makeModel([file('a.md', 'x')]);
    expect(model.upsert('page.html', '<h1>a</h1>')).toBe(true); // new -> shows up
    expect(model.currentVersion()).toBe(2);
    expect(model.manifest().files.map((f) => f.path)).toEqual(['a.md', 'page.html']);
    // A content re-save carries no manifest-relevant change (no frontmatter).
    expect(model.upsert('page.html', '<h1>b</h1>')).toBe(false);
    expect(model.currentVersion()).toBe(2);
    expect(model.remove('page.html')).toBe(true);
    expect(model.currentVersion()).toBe(3);
    expect(model.manifest().files.map((f) => f.path)).toEqual(['a.md']);
  });

  it('treats .skrive.toml changes as structure-relevant', () => {
    const model = makeModel([file('a.md', 'x')]);
    expect(model.upsert('.skrive.toml', '[project]\nname = "Renamed"\n')).toBe(
      true
    );
    expect(model.manifest().config.project.name).toBe('Renamed');

    expect(model.remove('.skrive.toml')).toBe(true);
    expect(model.manifest().config.project.name).toBeNull();
  });
});

describe('graph queries', () => {
  const files = [
    file('index.md', 'See [one](notes/one.md) and [[Two]].'),
    file('notes/one.md', 'Back to [index](../index.md). [dead](gone.md)'),
    file('notes/two.md', 'No links here.'),
    file('LICENSE', null)
  ];

  it('answers backlinks with snippets from in-memory bodies', () => {
    const model = makeModel(files);
    const backlinks = model.backlinks('index.md');
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]!.source).toBe('notes/one.md');
    expect(backlinks[0]!.snippet).toContain('Back to');
  });

  it('marks unresolved relative targets in outgoing edges', () => {
    const model = makeModel(files);
    const outgoing = model.outgoing('notes/one.md');
    const dead = outgoing.find((e) => e.target === 'notes/gone.md');
    expect(dead?.resolved).toBe(false);
  });

  it('lists dead links and orphaned files', () => {
    const model = makeModel(files);
    expect(model.deadLinks().map((d) => d.target)).toEqual(['notes/gone.md']);
    // two.md has no inbound relative edges (the wiki link doesn't count
    // in the backward index), one.md and index.md link to each other.
    expect(model.orphanedFiles()).toContain('notes/two.md');
  });

  it('keeps queries fresh after an upsert', () => {
    const model = makeModel(files);
    model.upsert('notes/two.md', 'Now links to [index](../index.md).');
    expect(
      model.backlinks('index.md').map((b) => b.source)
    ).toContain('notes/two.md');
  });
});

describe('search', () => {
  it('finds case-insensitive hits with UTF-16 columns', () => {
    const model = makeModel([file('a.md', 'Hello WORLD\nsecond world line')]);
    const hits = model.search('world', { caseSensitive: false });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ path: 'a.md', line: 1, column: 6 });
    expect(hits[1]).toMatchObject({ line: 2, column: 7 });
  });

  it('respects case sensitivity and trims CR from snippets', () => {
    const model = makeModel([file('a.md', 'foo\r\nFoo\r\n')]);
    const hits = model.search('Foo', { caseSensitive: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(2);
    expect(hits[0]!.snippet).toBe('Foo');
  });

  it('returns nothing for an empty query', () => {
    const model = makeModel([file('a.md', 'body')]);
    expect(model.search('', { caseSensitive: false })).toEqual([]);
  });
});

describe('rename planning', () => {
  it('previews references and definition updates', () => {
    const model = makeModel([
      file('index.md', 'Link to [one](notes/one.md).'),
      file('notes/one.md', 'Self link: [me](one.md).')
    ]);
    const preview = model.previewRename('notes/one.md', 'notes/uno.md');
    expect(preview.targetExists).toBe(false);
    expect(preview.references).toHaveLength(1);
    expect(preview.references[0]!.path).toBe('index.md');
    expect(preview.references[0]!.line).toBe(1);
  });

  it('flags an existing target', () => {
    const model = makeModel([file('a.md', 'x'), file('b.md', 'y')]);
    expect(model.previewRename('a.md', 'b.md').targetExists).toBe(true);
  });

  it('plans inline rewrites with correct relative paths', () => {
    const model = makeModel([
      file('index.md', 'Link to [one](notes/one.md).'),
      file('notes/one.md', 'target'),
      file('notes/sibling.md', 'Sibling [one](one.md).')
    ]);
    const plan = model.renamePlan('notes/one.md', 'deep/dir/one.md');
    expect(plan.referencesUpdated).toBe(2);
    const byPath = new Map(plan.writes.map((w) => [w.path, w.body]));
    expect(byPath.get('index.md')).toBe('Link to [one](deep/dir/one.md).');
    expect(byPath.get('notes/sibling.md')).toBe(
      'Sibling [one](../deep/dir/one.md).'
    );
  });

  it('rewrites wiki links to the new stem and skips reference uses', () => {
    const model = makeModel([
      file('a.md', 'Wiki [[One]] and use [text][label]\n\n[label]: one.md'),
      file('one.md', 'target')
    ]);
    const plan = model.renamePlan('one.md', 'renamed.md');
    const a = plan.writes.find((w) => w.path === 'a.md')!;
    expect(a.body).toContain('[[renamed]]');
    expect(a.body).toContain('[text][label]'); // use untouched
    expect(a.body).toContain('[label]: renamed.md');
  });

  it('rejects invalid plans', () => {
    const model = makeModel([file('a.md', 'x'), file('b.md', 'y')]);
    expect(() => model.renamePlan('a.md', 'a.md')).toThrow(/must differ/);
    expect(() => model.renamePlan('a.md', 'b.md')).toThrow(/already exists/);
    expect(() => model.renamePlan('missing.md', 'c.md')).toThrow(
      /does not exist/
    );
    expect(() => model.renamePlan('a.md', '../escape.md')).toThrow(/escapes/);
    expect(() => model.renamePlan('a.md', 'note.txt')).toThrow(/markdown/);
  });
});
