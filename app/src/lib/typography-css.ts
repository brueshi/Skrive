// Bridge from the preferences store to the CSS variables that drive
// editor + preview typography. Mounted once at app root via
// `useTypographyVars()`; the editor + preview CSS read
// `var(--skrive-editor-font)`, `--skrive-editor-font-size`,
// `--skrive-editor-line-height`, and `--skrive-measure` (the writing
// column width).

import { useEffect } from 'react';
import { usePreferencesStore } from '../stores/preferences';
import {
  selectLiveDocLineMeasure,
  useProjectStore
} from '../stores/project';
import {
  clampLineMeasureCh,
  type LineMeasure,
  type LineMeasureSetting
} from '@skrive/shared';
import { resolveEditorFontStack } from './typography';
import { bundledFont } from './typography-registry';

/** Writing-column widths per measure, in ch of the editor face. The
 *  value is resolved to px here rather than emitted as a raw `ch`
 *  length: `ch` resolves against each consumer's own font, and the
 *  block editor, raw source view, and preview set different faces —
 *  a px var keeps every view on one physical column. 'full' has no
 *  entry; it lifts the cap. */
export const MEASURE_CH: Record<Exclude<LineMeasure, 'full'>, number> = {
  narrow: 55,
  normal: 70,
  wide: 90
};

let measureCanvas: HTMLCanvasElement | null = null;
const chWidthCache = new Map<string, number>();

/** Drop a cached measurement so the next call re-measures. Needed when a
 *  bundled face finishes loading: the cached width for that key came from
 *  whatever fallback was resolvable at the time. */
export function invalidateChWidth(stack: string, sizePx: number): void {
  chWidthCache.delete(`${sizePx}|${stack}`);
}

/** Width of one ch (the "0" glyph) for a font, in px. Cached per
 *  stack+size. System stacks resolve at first paint, but a bundled face
 *  may not have loaded yet — until it does, measureText reports the
 *  fallback's "0". `useTypographyVars` invalidates and re-measures once
 *  the real face is available. */
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
 *  ch count (preset or clamped custom) and the current editor face, or
 *  an uncapped column. */
export function resolveMeasureCss(
  measure: LineMeasureSetting,
  stack: string,
  sizePx: number,
  customCh: number
): string {
  if (measure === 'full') return '100%';
  const ch =
    measure === 'custom' ? clampLineMeasureCh(customCh) : MEASURE_CH[measure];
  return `${Math.round(chWidthPx(stack, sizePx) * ch)}px`;
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
  const lineMeasureCustomCh = usePreferencesStore(
    (s) => s.lineMeasureCustomCh
  );
  // Per-document override (folio docMeta / frontmatter). Changes only on
  // doc switch or an explicit override edit — never per keystroke.
  const docLineMeasure = useProjectStore(selectLiveDocLineMeasure);

  useEffect(() => {
    const root = document.documentElement;
    const stack = resolveEditorFontStack(editorFont, editorCustomFontFamily);

    const apply = () => {
      root.style.setProperty('--skrive-editor-font', stack);
      root.style.setProperty('--skrive-editor-font-size', `${editorFontSize}px`);
      root.style.setProperty(
        '--skrive-editor-line-height',
        String(editorLineHeightX100 / 100)
      );
      root.style.setProperty(
        '--skrive-measure',
        resolveMeasureCss(
          docLineMeasure ?? lineMeasure,
          stack,
          editorFontSize,
          lineMeasureCustomCh
        )
      );
    };

    // Paint immediately. For a bundled face this sizes the column from the
    // fallback's metrics, which is wrong but close, and is corrected below
    // rather than leaving the column unset until the font arrives.
    apply();

    const family = bundledFont(editorFont)?.cssFamily;
    if (!family || typeof document === 'undefined' || !document.fonts) return;

    // The measured width of "0" changes the moment the real face lands, and
    // the writing column is derived from it. Re-measure then — but ignore a
    // load that resolves after the font has already changed again, or the
    // column would be sized for a face no longer selected.
    let cancelled = false;
    document.fonts
      .load(`${editorFontSize}px "${family}"`)
      .then(() => {
        if (cancelled) return;
        invalidateChWidth(stack, editorFontSize);
        apply();
      })
      .catch(() => {
        // A face that fails to load keeps the fallback metrics already
        // applied, which match what is actually rendering.
      });
    return () => {
      cancelled = true;
    };
  }, [
    editorFont,
    editorCustomFontFamily,
    editorFontSize,
    editorLineHeightX100,
    lineMeasure,
    lineMeasureCustomCh,
    docLineMeasure
  ]);
}
