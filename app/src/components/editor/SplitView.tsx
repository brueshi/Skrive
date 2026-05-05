// The three-mode editor surface: raw / split / preview.
//
// In raw mode the editor fills the pane. In preview mode the rendered
// output fills the pane. In split mode the pane is divided by a draggable
// 1px rule.
//
// Drag handling:
//   - Owns no local "current ratio" state. Pointer moves call
//     `onRatioChange` directly; the parent clamps and persists.
//   - Pointer capture is on the divider element; we do NOT listen on
//     window so nested iframes and picker overlays cannot swallow the
//     drag.
//   - Container bounding rect is frozen at pointerdown. Measuring on
//     every move is correct but wasteful; the pane can't resize during a
//     drag anyway.
//
// Per-file mode + ratio persistence wires through Phase 9. For Phase 2
// the parent owns these in-memory and they reset on app restart.

import { useRef, useState } from 'react';
import { Editor } from './Editor';
import { Preview } from './Preview';

export type LayoutMode = 'raw' | 'split' | 'preview';

type Props = {
  mode: LayoutMode;
  ratio: number;
  body: string;
  onChange: (next: string) => void;
  onRatioChange: (ratio: number) => void;
  onInternalLink?: (href: string) => void;
};

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

function clampRatio(r: number): number {
  if (Number.isNaN(r)) return 0.5;
  return Math.min(Math.max(r, MIN_RATIO), MAX_RATIO);
}

export function SplitView({
  mode,
  ratio,
  body,
  onChange,
  onRatioChange,
  onInternalLink
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragBoundsRef = useRef<{ left: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    dragBoundsRef.current = { left: rect.left, width: rect.width };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const bounds = dragBoundsRef.current;
    if (!bounds) return;
    const offset = e.clientX - bounds.left;
    onRatioChange(clampRatio(offset / bounds.width));
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragBoundsRef.current) return;
    setDragging(false);
    dragBoundsRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const editorFlex = ratio;
  const previewFlex = 1 - ratio;

  const classes = [
    'split-view',
    `mode-${mode}`,
    dragging ? 'dragging' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} ref={containerRef}>
      {mode !== 'preview' && (
        <div
          className="pane editor-pane"
          style={{ flexGrow: mode === 'split' ? editorFlex : 1 }}
        >
          <Editor value={body} onChange={onChange} />
        </div>
      )}

      {mode === 'split' && (
        <div
          className="divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize editor and preview"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      )}

      {mode !== 'raw' && (
        <div
          className="pane preview-pane"
          style={{ flexGrow: mode === 'split' ? previewFlex : 1 }}
        >
          <Preview body={body} onInternalLink={onInternalLink} />
        </div>
      )}
    </div>
  );
}
