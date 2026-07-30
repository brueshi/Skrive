// Markdown source-mode layout switch (SKR-197). Markdown / Split / Preview,
// centered in the EditorBar's middle band, where the formatting toolbar sits in
// rich mode (the two are mutually exclusive; a Markdown tab has no surface).
//
// This is the Segmented primitive rather than a bespoke control. It used to
// measure the active button in JS and slide a hand-positioned thumb; the
// primitive does the same job with a shared framer-motion element, so the
// measurement, the ResizeObserver and the thumb's own CSS are gone.

import { Segmented } from '../ui/Segmented';
import { useProjectStore } from '../../stores/project';
import type { LayoutMode } from '@skrive/shared';

const MODES: Array<{ id: LayoutMode; label: string }> = [
  { id: 'raw', label: 'Markdown' },
  { id: 'split', label: 'Split' },
  { id: 'preview', label: 'Preview' }
];

export function MarkdownLayoutToggle() {
  const tab = useProjectStore((s) => s.liveDoc);
  const setLiveDocLayoutMode = useProjectStore((s) => s.setLiveDocLayoutMode);

  if (!tab || tab.mode !== 'markdown') return null;

  return (
    <Segmented
      value={tab.layoutMode}
      onChange={(mode) => setLiveDocLayoutMode(tab.path, mode)}
      options={MODES}
      ariaLabel="Editor layout"
    />
  );
}
