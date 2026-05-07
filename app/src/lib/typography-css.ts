// Bridge from the preferences store to the CSS variables that drive
// editor + preview typography. Mounted once at app root via
// `useTypographyVars()`; the editor + preview CSS read
// `var(--skrive-editor-font)`, `--skrive-editor-font-size`,
// `--skrive-editor-line-height`.

import { useEffect } from 'react';
import { usePreferencesStore } from '../stores/preferences';
import { resolveEditorFontStack } from './typography';

export function useTypographyVars(): void {
  const editorFont = usePreferencesStore((s) => s.editorFont);
  const editorCustomFontFamily = usePreferencesStore(
    (s) => s.editorCustomFontFamily
  );
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize);
  const editorLineHeightX100 = usePreferencesStore(
    (s) => s.editorLineHeightX100
  );

  useEffect(() => {
    const root = document.documentElement;
    const stack = resolveEditorFontStack(editorFont, editorCustomFontFamily);
    root.style.setProperty('--skrive-editor-font', stack);
    root.style.setProperty('--skrive-editor-font-size', `${editorFontSize}px`);
    root.style.setProperty(
      '--skrive-editor-line-height',
      String(editorLineHeightX100 / 100)
    );
  }, [
    editorFont,
    editorCustomFontFamily,
    editorFontSize,
    editorLineHeightX100
  ]);
}
