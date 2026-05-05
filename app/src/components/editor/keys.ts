// Layout-mode keyboard shortcuts.
//
// ⌘1 / ⌘2 / ⌘3 cycle through raw / split / preview. We bind at the window
// level (not via CM6 keymap) because the shortcuts should work regardless
// of whether the editor or the preview pane has focus.
//
// Per-file mode persistence wires through Phase 9; Phase 2 ships the
// shortcut working against parent state in App.

import type { LayoutMode } from './SplitView';

export const LAYOUT_BY_KEY: Record<string, LayoutMode> = {
  '1': 'raw',
  '2': 'split',
  '3': 'preview'
};

/**
 * If the event is a Mod-{1,2,3} layout shortcut, returns the target
 * mode and the caller should preventDefault. Otherwise returns null.
 */
export function matchLayoutShortcut(e: KeyboardEvent): LayoutMode | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.shiftKey || e.altKey) return null;
  return LAYOUT_BY_KEY[e.key] ?? null;
}
