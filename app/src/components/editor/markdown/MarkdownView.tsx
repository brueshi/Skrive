// Markdown source mode (SKR-197). The `.md` editing experience: edit raw
// Markdown text, see a rendered preview. Three layouts — raw source only, a
// side-by-side split, or preview only — selected by the tab's layoutMode.
//
// The load-bearing property: this path never touches the block model. Editing is
// the RawSourceView textarea (text -> text; the save writes those bytes verbatim),
// and the preview is the unified md -> HTML pipeline (Preview). The block model is
// exclusively the `.folio` rich editor now — the SKR-153 round-trip class cannot
// recur here because there is no parse -> model -> serialize cycle.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LayoutMode } from '@skrive/shared';
import { RawSourceView, type RawViewState } from '../raw/RawSourceView';
import { Preview } from '../Preview';
import { WordCountBadge } from '../WordCountBadge';
import { computeWordCount } from '../../../lib/frontmatter';
import { usePreferencesStore } from '../../../stores/preferences';
import { useProjectStore } from '../../../stores/project';
import './MarkdownView.css';

type Props = {
  /** Canonical Markdown body (sans frontmatter). */
  body: string;
  /** Receives the edited text (text -> text). */
  onChange: (next: string) => void;
  /** Active document path, for the preview's relative-image resolution. */
  filePath: string;
  /** Project root, forwarded to the preview image resolver. */
  projectRoot: string;
  layoutMode: LayoutMode;
  /** Split divider position as the source pane's width fraction (0..1). */
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  /** Preview relative-link click (resolved + opened by the caller). */
  onInternalLink?: (href: string) => void;
};

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

export function MarkdownView({
  body,
  onChange,
  filePath,
  projectRoot,
  layoutMode,
  splitRatio,
  onSplitRatioChange,
  onInternalLink
}: Props): React.ReactElement {
  const splitRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // The preview renders from a live mirror of the source text, updated per
  // animation frame straight from the textarea — so it feels instant, decoupled
  // from the debounced store write (which stays the save / lint cadence). The
  // effect resyncs the mirror whenever the canonical body changes (a settled
  // edit, or an external change), which is a no-op when they've already
  // converged during typing.
  const [liveBody, setLiveBody] = useState(body);
  useEffect(() => setLiveBody(body), [body]);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef(body);

  const onLiveInput = useCallback((text: string) => {
    pendingRef.current = text;
    if (rafRef.current != null) return; // coalesce a burst to one render/frame
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setLiveBody(pendingRef.current);
    });
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  // Cycling the layout REMOUNTS the textarea: `raw` renders it as a direct child of
  // .md-view, `split` nests it two levels deeper, so React tears the old one down
  // rather than moving it. MarkdownView itself is keyed only by file path, so it
  // outlives every cycle — which makes it the right owner of the writer's place in
  // the text. The outgoing textarea reports caret + scroll here; the incoming one
  // reads them back (SKR-183).
  const viewStateRef = useRef<RawViewState | null>(null);
  const onViewStateChange = useCallback((s: RawViewState) => {
    viewStateRef.current = s;
  }, []);
  const getInitialViewState = useCallback(() => viewStateRef.current, []);

  // A mount that follows a layout change takes focus; a document's first mount does
  // not — opening a file should not steal focus from wherever the writer summoned it
  // (the sidebar, the palette). `isCycle` is read during render because the child's
  // mount effect runs before any effect here could set a flag.
  const lastLayoutRef = useRef(layoutMode);
  const isCycle = lastLayoutRef.current !== layoutMode;
  useEffect(() => {
    lastLayoutRef.current = layoutMode;
  }, [layoutMode]);

  const onDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const onDividerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const el = splitRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      onSplitRatioChange(Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)));
    },
    [onSplitRatioChange]
  );

  const onDividerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // The counter (SKR-53) rides the same live mirror the preview uses — the
  // per-frame onLiveInput channel — so it ticks in real time while typing in
  // raw and split, and follows the settled body in preview. Recomputed only
  // when the mirror text changes, never per render.
  const showWordCount = usePreferencesStore((s) => s.showWordCount);
  // Focus mode strips the ambient readouts (SKR-52). Gated at the render site,
  // not inside the badge, so the count recompute stops with it. The outline rail
  // on this path is Preview's to gate — it mounts the rail, so it owns that one.
  const focusMode = useProjectStore((s) => s.focusMode);
  const viewRef = useRef<HTMLDivElement>(null);

  // Preview mode has no textarea to focus. Focus the preview's own scroller instead,
  // so Space / PageDown scroll the prose the writer just cycled into rather than
  // falling through to <body>. Layout effect: focus lands before the frame paints.
  useLayoutEffect(() => {
    if (isCycle && layoutMode === 'preview') {
      viewRef.current?.querySelector<HTMLElement>('.preview')?.focus();
    }
  }, [isCycle, layoutMode]);

  const counts = useMemo(
    () =>
      showWordCount && !focusMode
        ? { words: computeWordCount(liveBody), chars: liveBody.length }
        : null,
    [showWordCount, focusMode, liveBody]
  );
  const badge = counts && <WordCountBadge counts={counts} scopeRef={viewRef} />;

  const source = (
    <RawSourceView
      body={body}
      onChange={onChange}
      onLiveInput={onLiveInput}
      getInitialViewState={getInitialViewState}
      onViewStateChange={onViewStateChange}
      autoFocus={isCycle}
    />
  );

  const preview = (
    <Preview
      body={liveBody}
      filePath={filePath}
      projectRoot={projectRoot}
      onInternalLink={onInternalLink}
      showRail={layoutMode === 'preview'}
    />
  );

  if (layoutMode === 'raw') {
    return (
      <div className="md-view" ref={viewRef}>
        {source}
        {badge}
      </div>
    );
  }
  if (layoutMode === 'preview') {
    return (
      <div className="md-view" ref={viewRef}>
        {preview}
        {badge}
      </div>
    );
  }

  // Split: source on the left, live preview on the right, draggable divider.
  const leftPct = Math.min(MAX_RATIO, Math.max(MIN_RATIO, splitRatio)) * 100;
  return (
    <div className="md-view" ref={viewRef}>
      <div className="md-split" ref={splitRef}>
        <div className="md-split-pane" style={{ flexBasis: `${leftPct}%` }}>
          {source}
        </div>
        <div
          className="md-split-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize source and preview"
          onPointerDown={onDividerDown}
          onPointerMove={onDividerMove}
          onPointerUp={onDividerUp}
        />
        <div className="md-split-pane md-split-pane--preview">{preview}</div>
      </div>
      {badge}
    </div>
  );
}
