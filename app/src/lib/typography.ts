// Editor font preset → CSS font-family stack.
//
// Two kinds of entry. Bundled faces come from typography-registry.ts and
// resolve to a family the app ships and loads itself. System entries resolve
// to a stack of names the OS may or may not have — the only way to offer
// faces we cannot redistribute, which is why Palatino and Iowan Old Style
// live here rather than in the bundle.

import type { EditorFontId } from '@skrive/shared';
import {
  BUNDLED_FONTS,
  bundledFont,
  bundledFontStack
} from './typography-registry';

/** Picker grouping. Bundled faces sort by role; everything the OS supplies
 *  collects under one heading so the distinction stays legible. */
export type FontGroup = 'Serif' | 'Sans' | 'Mono' | 'System';

export type EditorFontPreset = {
  id: EditorFontId;
  label: string;
  subtext: string;
  stack: string;
  group: FontGroup;
};

const EDITORIAL_STACK =
  '"Iowan Old Style", "Palatino Linotype", "Palatino", "Georgia", ui-serif, serif';

const ROLE_GROUP = {
  serif: 'Serif',
  sans: 'Sans',
  mono: 'Mono'
} as const satisfies Record<string, FontGroup>;

const BUNDLED_PRESETS: EditorFontPreset[] = BUNDLED_FONTS.map((font) => ({
  id: font.id,
  label: font.label,
  subtext: font.subtext,
  stack: bundledFontStack(font),
  group: ROLE_GROUP[font.role]
}));

const SYSTEM_PRESETS: EditorFontPreset[] = [
  {
    id: 'editorial',
    label: 'Editorial',
    subtext: 'Iowan Old Style',
    stack: EDITORIAL_STACK,
    group: 'System'
  },
  {
    id: 'classic',
    label: 'Classic',
    subtext: 'Palatino Linotype',
    stack:
      '"Palatino Linotype", "Palatino", "Book Antiqua", "Georgia", ui-serif, serif',
    group: 'System'
  },
  {
    id: 'screen',
    label: 'Screen',
    subtext: 'Charter',
    stack: '"Charter", "Georgia", ui-serif, serif',
    group: 'System'
  },
  {
    id: 'sans',
    label: 'Sans',
    subtext: 'System sans-serif',
    stack:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif',
    group: 'System'
  },
  {
    id: 'mono',
    label: 'Mono',
    subtext: 'System monospace',
    stack:
      'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace',
    group: 'System'
  },
  {
    id: 'custom',
    label: 'Custom',
    subtext: 'Pick your own',
    // Resolver builds a fresh stack from `editorCustomFontFamily`; the
    // entry exists so the picker UI can iterate uniformly.
    stack: EDITORIAL_STACK,
    group: 'System'
  }
];

export const EDITOR_FONT_PRESETS: EditorFontPreset[] = [
  ...BUNDLED_PRESETS,
  ...SYSTEM_PRESETS
];

/** Group order for the picker; bundled faces first, then what the OS has. */
export const FONT_GROUP_ORDER: FontGroup[] = ['Serif', 'Sans', 'Mono', 'System'];

/** True when the face is one the app ships, and so may still be loading.
 *  Only these can change the measured width of a "0" after first paint —
 *  system stacks are resolvable immediately. */
export function isBundledFont(id: EditorFontId): boolean {
  return bundledFont(id) !== undefined;
}

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
    const needsQuotes = /\s/.test(trimmed) && !/^['"].*['"]$/.test(trimmed);
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
