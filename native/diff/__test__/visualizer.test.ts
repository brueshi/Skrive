// Visualizer-side parity. The renderer turns LineDiffRow[] into a
// DiffSegment[] sequence (kept / change) plus per-row segment indices.
// Phase 5b's preview-segments.ts is the data layer; DiffView uses the
// segments directly. This test exercises the data layer against the
// fixtures so a regression in the coalescer trips here, not on a UI
// inspection.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeLineDiff } from '..';
import {
  rowToSegmentIndex,
  segmentsForPreview
} from '../../../app/src/lib/diff/preview-segments';

const FIXTURES = resolve(__dirname, '..', '..', '..', 'docs', 'fixtures', '3.3');

function loadFixture(name: string): { before: string; after: string } {
  const before = readFileSync(resolve(FIXTURES, `${name}-before.md`), 'utf8');
  const after = readFileSync(resolve(FIXTURES, `${name}-after.md`), 'utf8');
  return { before, after };
}

type LineDiffRow = {
  kind: string;
  before: string | null;
  after: string | null;
};

describe('preview-segments fixture parity', () => {
  it('reword: segments alternate kept → change → kept', () => {
    const { before, after } = loadFixture('reword');
    const rows = computeLineDiff(before, after) as LineDiffRow[];
    const segments = segmentsForPreview(rows);
    // Reword fixture: one paragraph rewritten in the middle. The
    // coalescer collapses the rewrite's adjacent delete+insert rows
    // into a single change segment, with kept text on either side.
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(segments[0].kind).toBe('kept');
    expect(segments.some((s) => s.kind === 'change')).toBe(true);
    const change = segments.find((s) => s.kind === 'change');
    expect(change!.beforeSource.length).toBeGreaterThan(0);
    expect(change!.afterSource.length).toBeGreaterThan(0);
  });

  it('row-to-segment map is monotonic and matches segment count', () => {
    const { before, after } = loadFixture('reword');
    const rows = computeLineDiff(before, after) as LineDiffRow[];
    const segments = segmentsForPreview(rows);
    const map = rowToSegmentIndex(rows);
    expect(map.length).toBe(rows.length);
    // Indices are non-decreasing — adjacent rows share a segment or
    // open the next one.
    for (let i = 1; i < map.length; i++) {
      expect(map[i]).toBeGreaterThanOrEqual(map[i - 1]!);
    }
    // Final index reaches the last segment.
    expect(map[map.length - 1]).toBe(segments.length - 1);
  });

  it('insert: pure insertions produce change segments with empty beforeSource', () => {
    const { before, after } = loadFixture('insert');
    const rows = computeLineDiff(before, after) as LineDiffRow[];
    const segments = segmentsForPreview(rows);
    const inserts = segments.filter(
      (s) => s.kind === 'change' && s.beforeSource.length === 0
    );
    expect(inserts.length).toBeGreaterThan(0);
    for (const seg of inserts) {
      expect(seg.afterSource.length).toBeGreaterThan(0);
    }
  });

  it('identical inputs yield exactly one kept segment', () => {
    const src = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const rows = computeLineDiff(src, src) as LineDiffRow[];
    const segments = segmentsForPreview(rows);
    expect(segments.length).toBe(1);
    expect(segments[0].kind).toBe('kept');
    expect(segments[0].beforeSource).toBe(segments[0].afterSource);
  });
});
