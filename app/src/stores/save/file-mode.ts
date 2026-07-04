// The editor-mode decision, in one place (SKR-196, extended in SKR-204/205). A
// file's extension picks its editing path: `.folio` is the native rich format
// (block model canonical); `.txt` / `.text` is plain text (raw edit, no Markdown
// preview, no frontmatter); `.html` / `.htm` is a read-only rendered viewer (no
// editing — see below); everything else is Markdown source. Decided once at open
// and carried on the tab so no save/load site re-derives it ad hoc.
//
// `view` is the only read-only mode: its surface never emits an edit, so a tab
// never goes dirty and no save path is ever reached (buildSavePayload rejects it
// defensively). Editing an `.html` is out of scope — the path is Convert to
// Skrive document (SKR-200) → edit the `.folio` → export back out (SKR-199).

export type EditorMode = 'markdown' | 'rich' | 'text' | 'view';

export function fileMode(path: string): EditorMode {
  if (/\.folio$/i.test(path)) return 'rich';
  if (/\.(txt|text)$/i.test(path)) return 'text';
  if (/\.(html|htm)$/i.test(path)) return 'view';
  return 'markdown';
}
