// Bridge from the preferences store to the CSS variables that drive
// editor + preview typography. Mounted once at app root via
// `useTypographyVars()`; the editor + preview CSS read
// `var(--skrive-editor-font)`, `--skrive-editor-font-size`,
// `--skrive-editor-line-height`, and `--skrive-measure` (the writing
// column width).

import { useEffect } from 'react';
import { usePreferencesStore } from '../stores/preferences';
import type { LineMeasure } from '@skrive/shared';
import { resolveEditorFontStack } from './typography';

/** Writing-column widths per measure, in ch of the editor face. The
 *  value is resolved to px here rather than emitted as a raw `ch`
 *  length: `ch` resolves against each consumer's own font, and the
 *  block editor, raw source view, and preview set different faces —
 *  a px var keeps every view on one physical column. 'full' has no
 *  entry; it lifts the cap. */
const MEASURE_CH: Record<Exclude<LineMeasure, 'full'>, number> = {
  narrow: 55,
  normal: 70,
  wide: 90
};

let measureCanvas: HTMLCanvasElement | null = null;
const chWidthCache = new Map<string, number>();

/** Width of one ch (the "0" glyph) for a font, in px. Cached per
 *  stack+size; the editor faces are system stacks that are available
 *  at first paint, so a one-shot measure is safe. If bundled faces
 *  ever load asynchronously, re-measure on `document.fonts.ready`. */
export function chWidthPx(stack: string, sizePx: number): number {
  const key = `${sizePx}|${stack}`;
  const cached = chWidthCache.get(key);
  if (cached !== undefined) return cached;
  // Approximation when no canvas is available (headless tests, a
  // failed 2D context): digits sit near half an em in text faces.
  let width = sizePx / 2;
  if (typeof document !== 'undefined') {
    measureCanvas ??= document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    if (ctx) {
      ctx.font = `${sizePx}px ${stack}`;
      const measured = ctx.measureText('0').width;
      if (measured > 0) width = measured;
    }
  }
  chWidthCache.set(key, width);
  return width;
}

/** The CSS length for `--skrive-measure`: a px cap derived from the
 *  ch preset and the current editor face, or an uncapped column. */
export function resolveMeasureCss(
  measure: LineMeasure,
  stack: string,
  sizePx: number
): string {
  if (measure === 'full') return '100%';
  return `${Math.round(chWidthPx(stack, sizePx) * MEASURE_CH[measure])}px`;
}

export function useTypographyVars(): void {
  const editorFont = usePreferencesStore((s) => s.editorFont);
  const editorCustomFontFamily = usePreferencesStore(
    (s) => s.editorCustomFontFamily
  );
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize);
  const editorLineHeightX100 = usePreferencesStore(
    (s) => s.editorLineHeightX100
  );
  const lineMeasure = usePreferencesStore((s) => s.lineMeasure);

  useEffect(() => {
    const root = document.documentElement;
    const stack = resolveEditorFontStack(editorFont, editorCustomFontFamily);
    root.style.setProperty('--skrive-editor-font', stack);
    root.style.setProperty('--skrive-editor-font-size', `${editorFontSize}px`);
    root.style.setProperty(
      '--skrive-editor-line-height',
      String(editorLineHeightX100 / 100)
    );
    root.style.setProperty(
      '--skrive-measure',
      resolveMeasureCss(lineMeasure, stack, editorFontSize)
    );
  }, [
    editorFont,
    editorCustomFontFamily,
    editorFontSize,
    editorLineHeightX100,
    lineMeasure
  ]);
}
