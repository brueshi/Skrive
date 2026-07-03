// The editor-mode decision, in one place (SKR-196, extended in SKR-204). A file's
// extension picks its editing path: `.folio` is the native rich format (block
// model canonical); `.txt` / `.text` is plain text (raw edit, no Markdown
// preview, no frontmatter); everything else is Markdown source. Decided once at
// open and carried on the tab so no save/load site re-derives it ad hoc.

export type EditorMode = 'markdown' | 'rich' | 'text';

export function fileMode(path: string): EditorMode {
  if (/\.folio$/i.test(path)) return 'rich';
  if (/\.(txt|text)$/i.test(path)) return 'text';
  return 'markdown';
}
