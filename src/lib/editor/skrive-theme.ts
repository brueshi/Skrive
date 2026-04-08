// The one default theme. No theme system at launch — this file is the entire
// visual identity of the editor surface. Colors come from CSS variables defined
// in `app.html` so the theme follows the OS color-scheme preference without
// having to swap extensions at runtime.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const baseTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--skrive-bg)",
    color: "var(--skrive-fg)",
    height: "100%",
    fontSize: "17px",
    fontFamily:
      '"Iowan Old Style", "Palatino Linotype", "Palatino", "Georgia", ui-serif, serif',
  },
  "&.cm-editor.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--skrive-fg)",
    padding: "3rem 0",
    maxWidth: "42rem",
    margin: "0 auto",
  },
  ".cm-line": {
    padding: "0 2rem",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--skrive-fg)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "var(--skrive-selection)",
    },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-gutters": {
    display: "none",
  },
});

// Markdown-aware syntax highlighting. The colors are deliberately restrained:
// emphasis, headings, code, and links are the only meaningful contrasts.
const skriveHighlightStyle = HighlightStyle.define([
  {
    tag: t.heading,
    fontWeight: "600",
    color: "var(--skrive-fg)",
  },
  { tag: t.heading1, fontSize: "1.6em", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.35em", lineHeight: "1.35" },
  { tag: t.heading3, fontSize: "1.15em" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.link, color: "var(--skrive-link)", textDecoration: "underline" },
  { tag: t.url, color: "var(--skrive-muted)" },
  {
    tag: [t.monospace, t.processingInstruction],
    fontFamily:
      'ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: "0.92em",
    color: "var(--skrive-fg)",
  },
  { tag: t.quote, color: "var(--skrive-muted)", fontStyle: "italic" },
  { tag: t.list, color: "var(--skrive-fg)" },
  {
    tag: [t.meta, t.comment],
    color: "var(--skrive-muted)",
  },
]);

export const skriveTheme = [baseTheme, syntaxHighlighting(skriveHighlightStyle)];
