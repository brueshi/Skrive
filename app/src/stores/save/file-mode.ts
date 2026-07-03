// The editor-mode decision, in one place (SKR-196). A file's extension picks its
// editing path: `.folio` is the native rich format (block model canonical),
// everything else is Markdown source. Decided once at open and carried on the tab
// so no save/load site re-derives it ad hoc.

export type EditorMode = 'markdown' | 'rich';

export function fileMode(path: string): EditorMode {
  return /\.folio$/i.test(path) ? 'rich' : 'markdown';
}
