// Editor font preset → CSS font-family stack. Mirrors v0.1's
// `src/lib/editor/fonts.ts` — preset values are settled.

import type { EditorFontId } from '@skrive/shared';

export type EditorFontPreset = {
  id: EditorFontId;
  label: string;
  subtext: string;
  stack: string;
};

const EDITORIAL_STACK =
  '"Iowan Old Style", "Palatino Linotype", "Palatino", "Georgia", ui-serif, serif';

export const EDITOR_FONT_PRESETS: EditorFontPreset[] = [
  {
    id: 'editorial',
    label: 'Editorial',
    subtext: 'Iowan Old Style',
    stack: EDITORIAL_STACK
  },
  {
    id: 'classic',
    label: 'Classic',
    subtext: 'Palatino Linotype',
    stack:
      '"Palatino Linotype", "Palatino", "Book Antiqua", "Georgia", ui-serif, serif'
  },
  {
    id: 'screen',
    label: 'Screen',
    subtext: 'Charter',
    stack: '"Charter", "Georgia", ui-serif, serif'
  },
  {
    id: 'sans',
    label: 'Sans',
    subtext: 'System sans-serif',
    stack:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif'
  },
  {
    id: 'mono',
    label: 'Mono',
    subtext: 'System monospace',
    stack:
      'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace'
  },
  {
    id: 'custom',
    label: 'Custom',
    subtext: 'Pick your own',
    // Resolver builds a fresh stack from `editorCustomFontFamily`; the
    // entry exists so the picker UI can iterate uniformly.
    stack: EDITORIAL_STACK
  }
];

/** Resolve the runtime CSS `font-family` value for a preset.
 *  "custom" sandwiches the user's family in front of the editorial
 *  fallback so a missing font falls back gracefully. */
export function resolveEditorFontStack(
  id: EditorFontId,
  customFamily: string
): string {
  if (id === 'custom') {
    const trimmed = customFamily.trim();
    if (trimmed.length === 0) return EDITORIAL_STACK;
    const needsQuotes =
      /\s/.test(trimmed) && !/^['"].*['"]$/.test(trimmed);
    const wrapped = needsQuotes ? `"${trimmed}"` : trimmed;
    return `${wrapped}, ${EDITORIAL_STACK}`;
  }
  const preset = EDITOR_FONT_PRESETS.find((p) => p.id === id);
  return preset?.stack ?? EDITORIAL_STACK;
}

export const FONT_SIZE_STEPS = [14, 16, 17, 18, 20, 22] as const;
export const LINE_HEIGHT_STEPS_X100 = [150, 170, 200] as const;

export function lineHeightLabel(x100: number): string {
  return (x100 / 100).toFixed(1);
}
