// Group a line-level diff into segments for preview-mode rendering.
//
// Raw mode renders one DOM row per line-diff entry so the two panes
// stay aligned index-for-index. Preview mode can't do that — rendered
// markdown is block-shaped, not line-shaped, and styling a `<p>` as
// "deleted" means the whole paragraph's rendered HTML carries the
// strikethrough, not a single source line. So we coalesce adjacent
// add/delete rows into a single "change" segment and render each
// change's before/after sources as a block of markdown on their
// respective pane.
//
// Limitations of this line-level approach (3.3a only):
//   - A "change" segment can span multiple paragraphs if the diff hunk
//     happens to be larger than one paragraph. The whole span renders
//     as one wrapped-with-diff-styling markdown block. That's a known
//     simplification; 3.3b's structural algorithm replaces this with
//     paragraph-granularity segments.
//   - Markdown blocks whose boundaries straddle an add/delete row
//     (e.g. a code fence with one line inserted) will render as two
//     separate, broken blocks. Rare in prose; not worth fixing here.

import type { LineDiffRow } from './line-diff';

/**
 * One coalesced diff region for preview rendering. Kept segments
 * carry identical before/after sources. Change segments may have
 * empty `beforeSource` (pure insertion — the before pane shows a
 * placeholder) or empty `afterSource` (pure deletion — the after
 * pane shows a placeholder); usually both are non-empty.
 */
export type DiffSegment = {
  kind: 'kept' | 'change';
  beforeSource: string;
  afterSource: string;
};

export function segmentsForPreview(rows: LineDiffRow[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let currentKind: 'kept' | 'change' | null = null;
  let beforeBuf: string[] = [];
  let afterBuf: string[] = [];

  const flush = () => {
    if (currentKind === null) return;
    if (beforeBuf.length === 0 && afterBuf.length === 0) return;
    segments.push({
      kind: currentKind,
      beforeSource: beforeBuf.join('\n'),
      afterSource: afterBuf.join('\n')
    });
    beforeBuf = [];
    afterBuf = [];
  };

  for (const row of rows) {
    const kind: 'kept' | 'change' = row.kind === 'kept' ? 'kept' : 'change';
    if (currentKind !== kind) {
      flush();
      currentKind = kind;
    }
    if (row.before !== null) beforeBuf.push(row.before);
    if (row.after !== null) afterBuf.push(row.after);
  }
  flush();

  return segments;
}

/**
 * What a given pane should render for a segment. Encodes the four
 * visual treatments the preview-mode diff produces:
 *
 *   - `kept`        — both panes, no decoration.
 *   - `deleted`     — before pane, strikethrough + opacity.
 *   - `added`       — after pane, sage tint.
 *   - `gap-added`   — before pane, placeholder for an after-only insertion.
 *   - `gap-deleted` — after pane, placeholder for a before-only deletion.
 *
 * `source` is the markdown text to render; absent on the gap kinds.
 */
export type PaneSegment =
  | { kind: 'kept'; source: string }
  | { kind: 'deleted'; source: string }
  | { kind: 'added'; source: string }
  | { kind: 'gap-added' }
  | { kind: 'gap-deleted' };

/**
 * For each row, the index of the segment that row belongs to. Same
 * segmentation rule as `segmentsForPreview` (kept vs change), so the
 * returned indices line up with that function's output. Used by the
 * raw-mode renderer to tag the first row of each segment with
 * `data-diff-seg-index`, enabling matched scroll and change
 * navigation without touching DOM heights.
 */
export function rowToSegmentIndex(rows: LineDiffRow[]): number[] {
  const out: number[] = new Array(rows.length);
  let segIdx = -1;
  let lastKind: 'kept' | 'change' | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const kind: 'kept' | 'change' = row.kind === 'kept' ? 'kept' : 'change';
    if (kind !== lastKind) {
      segIdx++;
      lastKind = kind;
    }
    out[i] = segIdx;
  }
  return out;
}

export function paneSegment(
  segment: DiffSegment,
  side: 'before' | 'after'
): PaneSegment {
  if (segment.kind === 'kept') {
    return {
      kind: 'kept',
      source: side === 'before' ? segment.beforeSource : segment.afterSource
    };
  }
  if (side === 'before') {
    if (segment.beforeSource.length === 0) return { kind: 'gap-added' };
    return { kind: 'deleted', source: segment.beforeSource };
  }
  if (segment.afterSource.length === 0) return { kind: 'gap-deleted' };
  return { kind: 'added', source: segment.afterSource };
}
