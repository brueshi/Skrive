// Markdown source mode (SKR-197). The `.md` editing experience: edit raw
// Markdown text, see a rendered preview. Three layouts — raw source only, a
// side-by-side split, or preview only — selected by the tab's layoutMode.
//
// The load-bearing property: this path never touches the block model. Editing is
// the RawSourceView textarea (text -> text; the save writes those bytes verbatim),
// and the preview is the unified md -> HTML pipeline (Preview). The block model is
// exclusively the `.folio` rich editor now — the SKR-153 round-trip class cannot
// recur here because there is no parse -> model -> serialize cycle.

import { useCallback, useRef } from 'react';
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
      body={body}
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
        <RawSourceView body={body} onChange={onChange} />
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
