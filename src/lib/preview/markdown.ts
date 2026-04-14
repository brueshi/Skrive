// Markdown pipeline for the preview pane. Uses `marked` with GFM enabled
// and line-break-sensitive parsing so the preview matches what the user sees
// in most editors.
//
// Phase 2.1 scope: this is the *basic* preview pipeline. It is deliberately
// not the same thing as the inline preview decorations from Phase 2.2 — the
// split-view preview pane renders a full HTML tree on every edit, while
// inline preview edits CodeMirror decorations in place. Two distinct systems.
//
// Sanitization note: the content we render comes exclusively from files the
// user has opened on their own disk. We treat it as trusted input and do not
// strip HTML. If we ever render Markdown from the network (e.g. importers
// pulling from Obsidian Publish), that caller must sanitize before handing
// content to this module.

import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: false,
});

export function renderMarkdown(body: string): string {
  // `marked.parse` returns a string synchronously when no async extensions
  // are registered, which is our case. The overload returns `string | Promise`,
  // so we cast.
  return marked.parse(body) as string;
}
