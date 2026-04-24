// Font preset → CSS font-family stack. The `editorFont` preference
// stores the id ("editorial", "classic", etc.); this is the only place
// the codebase knows what each id resolves to. Keep these stacks in
// sync with the labels in SettingsView's Editor section.
//
// "custom" returns the user-supplied family name with the editorial
// stack as a fallback so the editor never renders into nothing if the
// system doesn't have the requested font.

import type { EditorFontId } from "$lib/types";

export type EditorFontPreset = {
  id: EditorFontId;
  /** Short label shown on the picker tile. */
  label: string;
  /** Typeface name shown as muted subtext on the tile. */
  subtext: string;
  /** Concrete CSS font-family string. */
  stack: string;
};

const EDITORIAL_STACK =
  '"Iowan Old Style", "Palatino Linotype", "Palatino", "Georgia", ui-serif, serif';

export const EDITOR_FONT_PRESETS: EditorFontPreset[] = [
  {
    id: "editorial",
    label: "Editorial",
    subtext: "Iowan Old Style",
    stack: EDITORIAL_STACK,
  },
  {
    id: "classic",
    label: "Classic",
    subtext: "Palatino Linotype",
    stack:
      '"Palatino Linotype", "Palatino", "Book Antiqua", "Georgia", ui-serif, serif',
  },
  {
    id: "screen",
    label: "Screen",
    subtext: "Charter",
    stack: '"Charter", "Georgia", ui-serif, serif',
  },
  {
    id: "sans",
    label: "Sans",
    subtext: "System sans-serif",
    stack:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif',
  },
  {
    id: "mono",
    label: "Mono",
    subtext: "System monospace",
    stack:
      'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace',
  },
  {
    id: "custom",
    label: "Custom",
    subtext: "Pick your own",
    // The `stack` field is unused for "custom" at runtime — the
    // resolver builds a fresh string from `editorCustomFontFamily`
    // each time. We keep an entry here so the picker UI can iterate
    // over EDITOR_FONT_PRESETS uniformly.
    stack: EDITORIAL_STACK,
  },
];

/**
 * Build the actual `font-family` value used in CSS for the given
 * preset id. For "custom" we sandwich the user's family name in front
 * of the editorial fallback so missing-font fallback is graceful;
 * empty input is treated as "no override" and returns the editorial
 * stack verbatim.
 */
export function resolveEditorFontStack(
  id: EditorFontId,
  customFamily: string,
): string {
  if (id === "custom") {
    const trimmed = customFamily.trim();
    if (trimmed.length === 0) return EDITORIAL_STACK;
    // Quote the user's family name only if it contains whitespace and
    // isn't already quoted; otherwise pass it through. Names like
    // "Iowan Old Style" need quoting; "Inter" doesn't.
    const needsQuotes =
      /\s/.test(trimmed) && !/^['"].*['"]$/.test(trimmed);
    const wrapped = needsQuotes ? `"${trimmed}"` : trimmed;
    return `${wrapped}, ${EDITORIAL_STACK}`;
  }
  const preset = EDITOR_FONT_PRESETS.find((p) => p.id === id);
  return preset?.stack ?? EDITORIAL_STACK;
}
