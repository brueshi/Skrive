// Two-pane diff viewer. Parallel to `SplitView` — SplitView is "same
// file, two representations"; DiffView is "same representation, two
// versions." The two compose at the App layer via the chrome's mode
// state; see docs/3.3-diff-ui-design.md for the visual language.
//
// Phase 5 ports the Svelte v0.1 DiffView to React. The component is
// fully controlled — state lives with the parent (HistoryPanel in
// phase 10; the dev surface today).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { renderMarkdown } from '../../lib/preview/markdown';
import {
  paneSegment,
  rowToSegmentIndex,
  segmentsForPreview,
  type DiffSegment
} from '../../lib/diff/preview-segments';
import {
  currentChangeIndex,
  linearScrollTop,
  matchedScrollTop,
  measurePaneSegments,
  nextChangeTop,
  prevChangeTop,
  type SegMetric
} from '../../lib/diff/sync-scroll';
import type { LineDiffRow } from '../../lib/diff/line-diff';
import { IconX } from '../icons/IconX';
import { IconLayoutRaw } from '../icons/IconLayoutRaw';
import { IconLayoutPreview } from '../icons/IconLayoutPreview';

export type DiffMode = 'diff-raw' | 'diff-preview';

export type DiffSide = {
  /** Short pane label, e.g. "8 min ago" or "v0.1.5". */
  label: string;
  /** Used to render the "X min ago" caption + ISO tooltip. */
  timestampMs: number;
};

type Props = {
  mode: DiffMode;
  before: DiffSide;
  after: DiffSide;
  dividerRatio: number;
  rows: LineDiffRow[];
  onModeChange: (mode: DiffMode) => void;
  onDividerChange: (ratio: number) => void;
  onClose: () => void;
};

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

function clampRatio(r: number): number {
  if (Number.isNaN(r)) return 0.5;
  return Math.min(Math.max(r, MIN_RATIO), MAX_RATIO);
}

function gutterFor(
  kind: LineDiffRow['kind'],
  side: 'before' | 'after'
): string {
  if (kind === 'kept') return '·';
  if (kind === 'added') return side === 'after' ? '+' : '';
  return side === 'before' ? '−' : '';
}

function relativeTime(tsMs: number, nowMs: number): string {
  const delta = nowMs - tsMs;
  if (delta < 0) return 'just now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} wk${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  const years = Math.floor(days / 365);
  return `${years} yr${years === 1 ? '' : 's'} ago`;
}

type BeforeSegment =
  | { kind: 'kept'; html: string }
  | { kind: 'deleted'; html: string }
  | { kind: 'gap-added' };

type AfterSegment =
  | { kind: 'kept'; html: string }
  | { kind: 'added'; html: string }
  | { kind: 'gap-deleted' };

function renderBefore(segs: DiffSegment[]): BeforeSegment[] {
  return segs.map((seg) => {
    const pane = paneSegment(seg, 'before');
    switch (pane.kind) {
      case 'kept':
        return { kind: 'kept', html: renderMarkdown(pane.source) };
      case 'deleted':
        return { kind: 'deleted', html: renderMarkdown(pane.source) };
      case 'gap-added':
        return { kind: 'gap-added' };
      default:
        throw new Error(`before pane cannot render ${pane.kind}`);
    }
  });
}

function renderAfter(segs: DiffSegment[]): AfterSegment[] {
  return segs.map((seg) => {
    const pane = paneSegment(seg, 'after');
    switch (pane.kind) {
      case 'kept':
        return { kind: 'kept', html: renderMarkdown(pane.source) };
      case 'added':
        return { kind: 'added', html: renderMarkdown(pane.source) };
      case 'gap-deleted':
        return { kind: 'gap-deleted' };
      default:
        throw new Error(`after pane cannot render ${pane.kind}`);
    }
  });
}

export function DiffView({
  mode,
  before,
  after,
  dividerRatio,
  rows,
  onModeChange,
  onDividerChange,
  onClose
}: Props) {
  // ────────── Drag handling for the divider ──────────
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragBoundsRef = useRef<{ left: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      dragBoundsRef.current = { left: rect.left, width: rect.width };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const bounds = dragBoundsRef.current;
      if (!bounds) return;
      const offset = e.clientX - bounds.left;
      onDividerChange(clampRatio(offset / bounds.width));
    },
    [onDividerChange]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragBoundsRef.current) return;
      setDragging(false);
      dragBoundsRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    []
  );

  // ────────── Relative-time tick ──────────
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // ────────── Derived rendering data ──────────
  const segments = useMemo(() => segmentsForPreview(rows), [rows]);
  const beforeSegments = useMemo(() => renderBefore(segments), [segments]);
  const afterSegments = useMemo(() => renderAfter(segments), [segments]);
  const rowSegMap = useMemo(() => rowToSegmentIndex(rows), [rows]);
  const changeSegIndices = useMemo(
    () =>
      segments
        .map((s, i) => (s.kind === 'change' ? i : -1))
        .filter((i) => i >= 0),
    [segments]
  );

  // ────────── Scroll-sync state ──────────
  const [scrollMode, setScrollMode] = useState<'matched' | 'linear'>('matched');
  const beforePaneRef = useRef<HTMLDivElement | null>(null);
  const afterPaneRef = useRef<HTMLDivElement | null>(null);
  const beforeMetricsRef = useRef<SegMetric[]>([]);
  const afterMetricsRef = useRef<SegMetric[]>([]);
  const [currentChange, setCurrentChange] = useState(-1);

  const programmaticScrollRef = useRef(false);
  const pendingRafRef = useRef<number | null>(null);

  const computeTargetScrollTop = useCallback(
    (side: 'before' | 'after'): number => {
      const from =
        side === 'before' ? beforePaneRef.current : afterPaneRef.current;
      const to =
        side === 'before' ? afterPaneRef.current : beforePaneRef.current;
      if (!from || !to) return 0;
      const fromMetrics =
        side === 'before' ? beforeMetricsRef.current : afterMetricsRef.current;
      const toMetrics =
        side === 'before' ? afterMetricsRef.current : beforeMetricsRef.current;
      // Raw rows are pre-aligned across panes; direct match is exact.
      if (mode === 'diff-raw') {
        return Math.min(from.scrollTop, to.scrollHeight);
      }
      if (scrollMode === 'matched') {
        return matchedScrollTop(
          from.scrollTop,
          fromMetrics,
          toMetrics,
          from.scrollHeight,
          to.scrollHeight
        );
      }
      return linearScrollTop(from.scrollTop, from.scrollHeight, to.scrollHeight);
    },
    [mode, scrollMode]
  );

  const syncFrom = useCallback(
    (side: 'before' | 'after') => {
      const from =
        side === 'before' ? beforePaneRef.current : afterPaneRef.current;
      const to =
        side === 'before' ? afterPaneRef.current : beforePaneRef.current;
      if (!from || !to) return;
      const target = computeTargetScrollTop(side);
      setCurrentChange(
        currentChangeIndex(
          from.scrollTop,
          side === 'before'
            ? beforeMetricsRef.current
            : afterMetricsRef.current,
          changeSegIndices
        )
      );
      if (Math.abs(to.scrollTop - target) < 0.5) return;
      programmaticScrollRef.current = true;
      to.scrollTop = target;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    },
    [computeTargetScrollTop, changeSegIndices]
  );

  const scheduleSyncFrom = useCallback(
    (side: 'before' | 'after') => {
      if (programmaticScrollRef.current) return;
      if (pendingRafRef.current !== null) return;
      pendingRafRef.current = requestAnimationFrame(() => {
        pendingRafRef.current = null;
        syncFrom(side);
      });
    },
    [syncFrom]
  );

  const remeasure = useCallback(() => {
    if (beforePaneRef.current) {
      beforeMetricsRef.current = measurePaneSegments(beforePaneRef.current);
    }
    if (afterPaneRef.current) {
      afterMetricsRef.current = measurePaneSegments(afterPaneRef.current);
    }
  }, []);

  // Re-measure after every layout-changing input. `useLayoutEffect`
  // fires after DOM commit but before paint; the rAF inside lets the
  // browser actually run layout once before we read offsetTop/Height.
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(remeasure);
    return () => cancelAnimationFrame(raf);
  }, [mode, rows, dividerRatio, remeasure]);

  useEffect(() => {
    const handler = () => remeasure();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [remeasure]);

  // ────────── Change navigation ──────────
  const scrollTo = useCallback(
    (y: number) => {
      const before = beforePaneRef.current;
      if (!before) return;
      programmaticScrollRef.current = true;
      before.scrollTop = y;

      const after = afterPaneRef.current;
      if (after) {
        let target: number;
        if (mode === 'diff-raw') {
          target = Math.min(y, after.scrollHeight);
        } else if (scrollMode === 'matched') {
          target = matchedScrollTop(
            y,
            beforeMetricsRef.current,
            afterMetricsRef.current,
            before.scrollHeight,
            after.scrollHeight
          );
        } else {
          target = linearScrollTop(y, before.scrollHeight, after.scrollHeight);
        }
        after.scrollTop = target;
      }

      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        setCurrentChange(
          currentChangeIndex(y, beforeMetricsRef.current, changeSegIndices)
        );
      });
    },
    [mode, scrollMode, changeSegIndices]
  );

  const gotoNextChange = useCallback(() => {
    const before = beforePaneRef.current;
    if (!before) return;
    const target = nextChangeTop(
      before.scrollTop,
      beforeMetricsRef.current,
      changeSegIndices
    );
    if (target !== null) scrollTo(target);
  }, [changeSegIndices, scrollTo]);

  const gotoPrevChange = useCallback(() => {
    const before = beforePaneRef.current;
    if (!before) return;
    const target = prevChangeTop(
      before.scrollTop,
      beforeMetricsRef.current,
      changeSegIndices
    );
    if (target !== null) scrollTo(target);
  }, [changeSegIndices, scrollTo]);

  const gotoFirstChange = useCallback(() => {
    if (changeSegIndices.length === 0) return;
    const first = beforeMetricsRef.current.find(
      (m) => m.index === changeSegIndices[0]
    );
    if (first) scrollTo(first.top);
  }, [changeSegIndices, scrollTo]);

  const gotoLastChange = useCallback(() => {
    if (changeSegIndices.length === 0) return;
    const last = beforeMetricsRef.current.find(
      (m) => m.index === changeSegIndices[changeSegIndices.length - 1]
    );
    if (last) scrollTo(last.top);
  }, [changeSegIndices, scrollTo]);

  // Window-scoped while mounted. Skip when focus is in an editable
  // surface — n/p/j/k are valid characters anywhere a user types.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const editable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable === true;
      if (editable && e.key !== 'Escape') return;
      const key = e.key;
      if (key === 'n' || key === 'j') {
        e.preventDefault();
        gotoNextChange();
      } else if (key === 'p' || key === 'k') {
        e.preventDefault();
        gotoPrevChange();
      } else if (key === 'Home') {
        e.preventDefault();
        gotoFirstChange();
      } else if (key === 'End') {
        e.preventDefault();
        gotoLastChange();
      } else if (key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gotoNextChange, gotoPrevChange, gotoFirstChange, gotoLastChange, onClose]);

  // UI counter values. Internal -1 means "above all changes" → the
  // template renders that as 0 ("0 of N" = before the first change).
  const changeCount = changeSegIndices.length;
  const currentChangeDisplay = currentChange < 0 ? 0 : currentChange + 1;

  const containerStyle = {
    ['--diff-left-ratio' as string]: String(dividerRatio)
  };

  return (
    <div
      className={`diff-view${dragging ? ' dragging' : ''}`}
      ref={containerRef}
      style={containerStyle as React.CSSProperties}
    >
      <header className="diff-chrome">
        <div className="diff-chrome-slot diff-chrome-slot-before">
          <span className="diff-pane-label">
            <span className="diff-pane-label-kind">Before</span>
            <span
              className="diff-pane-label-name"
              title={new Date(before.timestampMs).toISOString()}
            >
              {before.label}
            </span>
            <span className="diff-pane-label-time">
              — {relativeTime(before.timestampMs, now)}
            </span>
          </span>
        </div>
        <div className="diff-chrome-divider" aria-hidden="true" />
        <div className="diff-chrome-slot diff-chrome-slot-after">
          <span className="diff-pane-label">
            <span className="diff-pane-label-kind">After</span>
            <span
              className="diff-pane-label-name"
              title={new Date(after.timestampMs).toISOString()}
            >
              {after.label}
            </span>
            <span className="diff-pane-label-time">
              — {relativeTime(after.timestampMs, now)}
            </span>
          </span>
          <div className="diff-actions">
            {changeCount > 0 && (
              <span
                className="diff-change-counter"
                title="Current change of total  ·  n/p to navigate"
              >
                {currentChangeDisplay} of {changeCount}
              </span>
            )}
            <div
              className="diff-scroll-toggle"
              role="group"
              aria-label="Scroll sync mode"
              title="Scroll sync: matched keeps paired blocks aligned; linear maps scroll position by pane height"
            >
              <button
                type="button"
                className={`diff-scroll-button${scrollMode === 'matched' ? ' active' : ''}`}
                aria-pressed={scrollMode === 'matched'}
                onClick={() => setScrollMode('matched')}
              >
                matched
              </button>
              <button
                type="button"
                className={`diff-scroll-button${scrollMode === 'linear' ? ' active' : ''}`}
                aria-pressed={scrollMode === 'linear'}
                onClick={() => setScrollMode('linear')}
              >
                linear
              </button>
            </div>
            <div
              className="diff-mode-toggle"
              role="group"
              aria-label="Diff representation"
            >
              <button
                type="button"
                className={`diff-mode-button${mode === 'diff-raw' ? ' active' : ''}`}
                aria-pressed={mode === 'diff-raw'}
                title="Diff raw source"
                onClick={() => onModeChange('diff-raw')}
              >
                <IconLayoutRaw size={16} />
              </button>
              <button
                type="button"
                className={`diff-mode-button${mode === 'diff-preview' ? ' active' : ''}`}
                aria-pressed={mode === 'diff-preview'}
                title="Diff rendered preview"
                onClick={() => onModeChange('diff-preview')}
              >
                <IconLayoutPreview size={16} />
              </button>
            </div>
            <button
              type="button"
              className="diff-close"
              aria-label="Exit diff mode"
              title="Exit diff  Esc"
              onClick={onClose}
            >
              <IconX size={16} />
            </button>
          </div>
        </div>
      </header>

      <div className="diff-panes">
        <div className="diff-pane diff-pane-before">
          {mode === 'diff-preview' ? (
            <div
              className="diff-pane-body diff-pane-preview"
              ref={beforePaneRef}
              onScroll={() => scheduleSyncFrom('before')}
            >
              {beforeSegments.map((seg, i) =>
                seg.kind === 'gap-added' ? (
                  <div
                    key={i}
                    className="diff-preview-seg diff-preview-gap-added"
                    data-diff-seg-index={i}
                  >
                    <span className="diff-preview-chip">added</span>
                  </div>
                ) : (
                  <div
                    key={i}
                    className={`diff-preview-seg diff-preview-${seg.kind}`}
                    data-diff-seg-index={i}
                    dangerouslySetInnerHTML={{ __html: seg.html }}
                  />
                )
              )}
            </div>
          ) : (
            <div
              className="diff-pane-body diff-pane-raw"
              ref={beforePaneRef}
              onScroll={() => scheduleSyncFrom('before')}
            >
              <div className="diff-rows">
                {rows.map((row, i) => {
                  const segIdx = rowSegMap[i];
                  const isSegStart = i === 0 || rowSegMap[i - 1] !== segIdx;
                  return (
                    <div
                      key={i}
                      className={`diff-row diff-row-${row.kind}`}
                      data-diff-seg-index={isSegStart ? segIdx : undefined}
                    >
                      <span className="diff-gutter">
                        {gutterFor(row.kind, 'before')}
                      </span>
                      {row.before !== null ? (
                        <span className="diff-text">{row.before || ' '}</span>
                      ) : (
                        <span
                          className="diff-text diff-text-placeholder"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div
          className="diff-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize before and after"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />

        <div className="diff-pane diff-pane-after">
          {mode === 'diff-preview' ? (
            <div
              className="diff-pane-body diff-pane-preview"
              ref={afterPaneRef}
              onScroll={() => scheduleSyncFrom('after')}
            >
              {afterSegments.map((seg, i) =>
                seg.kind === 'gap-deleted' ? (
                  <div
                    key={i}
                    className="diff-preview-seg diff-preview-gap-deleted"
                    data-diff-seg-index={i}
                  >
                    <span className="diff-preview-chip">deleted</span>
                  </div>
                ) : (
                  <div
                    key={i}
                    className={`diff-preview-seg diff-preview-${seg.kind}`}
                    data-diff-seg-index={i}
                    dangerouslySetInnerHTML={{ __html: seg.html }}
                  />
                )
              )}
            </div>
          ) : (
            <div
              className="diff-pane-body diff-pane-raw"
              ref={afterPaneRef}
              onScroll={() => scheduleSyncFrom('after')}
            >
              <div className="diff-rows">
                {rows.map((row, i) => {
                  const segIdx = rowSegMap[i];
                  const isSegStart = i === 0 || rowSegMap[i - 1] !== segIdx;
                  return (
                    <div
                      key={i}
                      className={`diff-row diff-row-${row.kind}`}
                      data-diff-seg-index={isSegStart ? segIdx : undefined}
                    >
                      <span className="diff-gutter">
                        {gutterFor(row.kind, 'after')}
                      </span>
                      {row.after !== null ? (
                        <span className="diff-text">{row.after || ' '}</span>
                      ) : (
                        <span
                          className="diff-text diff-text-placeholder"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
