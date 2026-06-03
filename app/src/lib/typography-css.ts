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

/** Writing-column widths per measure. Normal is the long-standing 42rem
 *  prose measure; narrow/wide bracket it for tighter or roomier lines. */
const MEASURE_REM: Record<LineMeasure, string> = {
  narrow: '36rem',
  normal: '42rem',
  wide: '50rem'
};

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
    root.style.setProperty('--skrive-measure', MEASURE_REM[lineMeasure]);
  }, [
    editorFont,
    editorCustomFontFamily,
    editorFontSize,
    editorLineHeightX100,
    lineMeasure
  ]);
}
