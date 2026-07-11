// Markdown source-mode layout switch (SKR-197). A segmented pill control —
// Markdown / Split / Preview — centered in the EditorBar's middle band, where the
// formatting toolbar sits in rich mode (the two are mutually exclusive; a Markdown
// tab has no surface). The active segment is a raised pill that SLIDES and resizes
// to the selected label: a measured thumb tracks the active button's box, animated
// via a transform/width transition (see EditorBar.css).

import { useLayoutEffect, useRef, useState } from 'react';
import { useProjectStore } from '../../stores/project';
import type { LayoutMode } from '@skrive/shared';

const MODES: ReadonlyArray<{ mode: LayoutMode; label: string }> = [
  { mode: 'raw', label: 'Markdown' },
  { mode: 'split', label: 'Split' },
  { mode: 'preview', label: 'Preview' }
];

export function MarkdownLayoutToggle() {
  const tab = useProjectStore((s) => s.liveDoc);
  const setLiveDocLayoutMode = useProjectStore((s) => s.setLiveDocLayoutMode);

  const trackRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  const isMarkdown = !!tab && tab.mode === 'markdown';
  const activeIndex = isMarkdown
    ? MODES.findIndex((m) => m.mode === tab.layoutMode)
    : -1;

  // Measure the active segment so the thumb can slide/resize to it. A
  // ResizeObserver re-measures if the control's width changes (font load, theme).
  // useLayoutEffect writes the position before paint, so the initial placement
  // lands without a flash; only later active-index changes cross a transition.
  useLayoutEffect(() => {
    if (activeIndex < 0) return;
    const measure = () => {
      const btn = btnRefs.current[activeIndex];
      if (btn) setThumb({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    measure();
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    return () => ro.disconnect();
  }, [activeIndex]);

  if (!isMarkdown) return null;

  return (
    <div className="md-layout-toggle" role="group" aria-label="Editor layout" ref={trackRef}>
      {thumb && (
        <span
          className="md-layout-thumb"
          aria-hidden="true"
          style={{ transform: `translateX(${thumb.left}px)`, width: `${thumb.width}px` }}
        />
      )}
      {MODES.map(({ mode, label }, i) => {
        const active = tab.layoutMode === mode;
        return (
          <button
            key={mode}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            className={`md-layout-btn${active ? ' active' : ''}`}
            aria-pressed={active}
            onClick={() => setLiveDocLayoutMode(tab.path, mode)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
