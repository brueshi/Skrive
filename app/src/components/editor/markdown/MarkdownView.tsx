// Markdown source mode (SKR-197). The `.md` editing experience: edit raw
// Markdown text, see a rendered preview. Three layouts — raw source only, a
// side-by-side split, or preview only — selected by the tab's layoutMode.
//
// The load-bearing property: this path never touches the block model. Editing is
// the RawSourceView textarea (text -> text; the save writes those bytes verbatim),
// and the preview is the unified md -> HTML pipeline (Preview). The block model is
// exclusively the `.folio` rich editor now — the SKR-153 round-trip class cannot
// recur here because there is no parse -> model -> serialize cycle.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutMode } from '@skrive/shared';
import { RawSourceView } from '../raw/RawSourceView';
import { Preview } from '../Preview';
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
    return <RawSourceView body={body} onChange={onChange} />;
  }
  if (layoutMode === 'preview') {
    return preview;
  }

  // Split: source on the left, live preview on the right, draggable divider.
  const leftPct = Math.min(MAX_RATIO, Math.max(MIN_RATIO, splitRatio)) * 100;
  return (
    <div className="md-split" ref={splitRef}>
      <div className="md-split-pane" style={{ flexBasis: `${leftPct}%` }}>
        <RawSourceView body={body} onChange={onChange} onLiveInput={onLiveInput} />
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
  );
}
