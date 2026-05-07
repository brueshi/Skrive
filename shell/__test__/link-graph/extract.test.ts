// Mirrors the inline unit tests in src-tauri/src/link_graph.rs::tests.
// Synthetic inputs probe edge cases the fixture harness can't easily
// hand-author without becoming brittle (exact range / line / column).

import { describe, expect, it } from 'vitest';
import { extract } from '../../src/lib/link-graph/extract';
import type { Edge, LinkTarget } from '@skrive/shared';

function relativeTargets(edges: Edge[]): string[] {
  return edges.flatMap((e) =>
    e.target.kind === 'relative' ? [e.target.path] : []
  );
}

function targetEqual(a: LinkTarget, b: LinkTarget): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'relative'
    ? (b as { kind: 'relative'; path: string }).path === a.path
    : (b as { kind: 'wiki'; name: string }).name === a.name;
}

describe('extract — inline links', () => {
  it('relative inline link resolves and narrows range to URL', () => {
    const body = 'See [intro](intro.md) for context.';
    const edges = extract(body, 'posts/index.md');
    expect(relativeTargets(edges)).toContain('posts/intro.md');

    const inline = edges.find((e) => e.kind === 'inline')!;
    expect(body.slice(inline.range.start, inline.range.end)).toBe('intro.md');
  });

  it('skips external link targets', () => {
    const body = '[google](https://google.com) and [#anchor](#anchor)';
    expect(extract(body, 'a.md')).toEqual([]);
  });

  it('parent-traversal targets resolve project-relative', () => {
    const body = '[up](../sibling.md)';
    const edges = extract(body, 'posts/nested/page.md');
    expect(relativeTargets(edges)).toContain('posts/sibling.md');
  });

  it('line and column are 0-indexed code units', () => {
    const body = 'line0\n  [l2](target.md)\n';
    const edges = extract(body, 'a.md');
    const inline = edges.find((e) => e.kind === 'inline')!;
    expect(inline.line).toBe(1);
    // URL starts after `  [l2](` = 7 characters in.
    expect(inline.column).toBe(7);
  });
});

describe('extract — wiki links', () => {
  it('wiki link with alias keeps name only', () => {
    const body = 'Refer to [[Other Note|alias]] please.';
    const edges = extract(body, 'a.md');
    const wiki = edges.find((e) => e.kind === 'wiki')!;
    expect(targetEqual(wiki.target, { kind: 'wiki', name: 'Other Note' })).toBe(
      true
    );
    expect(body.slice(wiki.range.start, wiki.range.end)).toBe('Other Note');
  });

  it('wiki link without alias covers the inner name', () => {
    const body = 'See [[Setup]] first.';
    const edges = extract(body, 'a.md');
    const wiki = edges.find((e) => e.kind === 'wiki')!;
    expect(body.slice(wiki.range.start, wiki.range.end)).toBe('Setup');
  });
});

describe('extract — reference-style', () => {
  it('reference use + definition both surface', () => {
    const body =
      'See [introduction][intro] and the [setup guide][setup].\n\n' +
      '[intro]: notes/introduction.md\n' +
      '[SETUP]: notes/setup.md "Setup"\n';
    const edges = extract(body, 'index.md');

    const uses = edges.filter((e) => e.kind === 'referenceUse');
    const defs = edges.filter((e) => e.kind === 'referenceDefinition');
    expect(uses.length).toBe(2);
    expect(defs.length).toBe(2);

    expect(body.slice(defs[0]!.range.start, defs[0]!.range.end)).toBe(
      'notes/introduction.md'
    );
    expect(body.slice(defs[1]!.range.start, defs[1]!.range.end)).toBe(
      'notes/setup.md'
    );

    // Case-insensitive label match: `[setup]` use → `[SETUP]` def.
    const setupUse = uses.find(
      (e) => e.target.kind === 'relative' && e.target.path === 'notes/setup.md'
    );
    expect(setupUse).toBeDefined();
  });

  it('skips definitions inside fenced code blocks', () => {
    const body =
      'A paragraph.\n\n' +
      '```\n' +
      '[not-a-def]: should-be-ignored.md\n' +
      '```\n\n' +
      '[real]: notes/real.md\n';
    const edges = extract(body, 'a.md');
    const defs = edges.filter((e) => e.kind === 'referenceDefinition');
    expect(defs.length).toBe(1);
    expect(
      defs[0]!.target.kind === 'relative' &&
        defs[0]!.target.path === 'notes/real.md'
    ).toBe(true);
  });

  it('definitions not at a block boundary are not picked up', () => {
    const body =
      'Prose text that runs into the next line.\n' +
      '[intro]: notes/introduction.md\n';
    const edges = extract(body, 'a.md');
    expect(edges.filter((e) => e.kind === 'referenceDefinition')).toEqual([]);
  });

  it('angle-bracketed definition target', () => {
    const body = '[glossary]: <notes/glossary.md>\n';
    const edges = extract(body, 'a.md');
    const def = edges.find((e) => e.kind === 'referenceDefinition')!;
    expect(body.slice(def.range.start, def.range.end)).toBe(
      'notes/glossary.md'
    );
  });
});
