// The bundled writing faces: what ships, what to call it, and who made it.
//
// This is the data behind three surfaces — the Appearance › Typography
// picker, the `--skrive-editor-font` stack resolver in typography.ts, and
// the credits block in Settings › About. The @font-face declarations that
// actually load the files live beside the files themselves in
// assets/fonts/fonts.css; `cssFamily` is the join between the two and must
// match the family name declared there.
//
// Everything here is under the SIL Open Font License 1.1, and each family's
// license text ships in its own directory. Adding a face means adding the
// files, the @font-face pair, its license, and an entry here.

import type { EditorFontId } from '@skrive/shared';

export type FontRole = 'serif' | 'sans' | 'mono';

export type BundledFont = {
  id: EditorFontId;
  /** Plain name, as the designer spells it. */
  label: string;
  /** One line on what the face is for; shown under the label in the picker. */
  subtext: string;
  role: FontRole;
  /** Family name as declared in assets/fonts/fonts.css. */
  cssFamily: string;
  /** Upstream project, for the About credits. */
  credit: string;
};

/** Fallbacks appended after a bundled family, so a face that fails to load
 *  still leaves readable prose rather than a default-serif surprise. */
export const ROLE_FALLBACK: Record<FontRole, string> = {
  serif:
    '"Iowan Old Style", "Palatino Linotype", "Palatino", "Georgia", ui-serif, serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace'
};

export const BUNDLED_FONTS: BundledFont[] = [
  {
    id: 'literata',
    label: 'Literata',
    subtext: 'Built for long reading on screen',
    role: 'serif',
    cssFamily: 'Literata',
    credit: 'TypeTogether'
  },
  {
    id: 'newsreader',
    label: 'Newsreader',
    subtext: 'Editorial, with more edge',
    role: 'serif',
    cssFamily: 'Newsreader',
    credit: 'Production Type'
  },
  {
    id: 'source-serif-4',
    label: 'Source Serif 4',
    subtext: 'Neutral and unfussy',
    role: 'serif',
    cssFamily: 'Source Serif 4',
    credit: 'Adobe'
  },
  {
    id: 'eb-garamond',
    label: 'EB Garamond',
    subtext: 'Classical; reads small, so size it up',
    role: 'serif',
    cssFamily: 'EB Garamond',
    credit: 'Octavio Pardo, Georg Duffner'
  },
  {
    id: 'alegreya',
    label: 'Alegreya',
    subtext: 'Warm, humanist, made for literature',
    role: 'serif',
    cssFamily: 'Alegreya',
    credit: 'Huerta Tipográfica'
  },
  {
    id: 'inter',
    label: 'Inter',
    subtext: 'Clean and even at any size',
    role: 'sans',
    cssFamily: 'Inter',
    credit: 'Rasmus Andersson'
  },
  {
    id: 'source-sans-3',
    label: 'Source Sans 3',
    subtext: 'Warmer than Inter for running prose',
    role: 'sans',
    cssFamily: 'Source Sans 3',
    credit: 'Adobe'
  },
  {
    id: 'atkinson-hyperlegible',
    label: 'Atkinson Hyperlegible',
    subtext: 'Letterforms drawn to be hard to confuse',
    role: 'sans',
    cssFamily: 'Atkinson Hyperlegible Next',
    credit: 'Braille Institute'
  },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    subtext: 'Even monospace with a tall x-height',
    role: 'mono',
    cssFamily: 'JetBrains Mono',
    credit: 'JetBrains'
  },
  {
    id: 'monaspace-neon',
    label: 'Monaspace Neon',
    subtext: 'Monospace with the spacing smoothed out',
    role: 'mono',
    cssFamily: 'Monaspace Neon Var',
    credit: 'GitHub Next'
  }
];

const BY_ID = new Map<EditorFontId, BundledFont>(
  BUNDLED_FONTS.map((f) => [f.id, f])
);

export function bundledFont(id: EditorFontId): BundledFont | undefined {
  return BY_ID.get(id);
}

/** The full `font-family` value for a bundled face: the family itself, then
 *  the role's system fallbacks. */
export function bundledFontStack(font: BundledFont): string {
  return `"${font.cssFamily}", ${ROLE_FALLBACK[font.role]}`;
}
