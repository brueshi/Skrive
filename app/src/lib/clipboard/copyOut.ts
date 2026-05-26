// Copy-out half of the clipboard boundary: turn an editor selection into a
// dual-write clipboard payload.
//
// The payload carries two representations of the same content:
//   - text/plain  the raw Markdown source of the selection
//   - text/html   that Markdown rendered to HTML by the *same* pipeline the
//                 preview uses (`renderMarkdown`)
//
// Markdown-aware and plain-text targets read the source and get clean
// Markdown; rich-text targets (Gmail, Docs, Word) read the HTML and get
// formatting instead of literal `##` and `**`. Because the HTML comes from the
// preview renderer, what the user sees in the preview is what they paste.
//
// Image URLs are left to `renderMarkdown`'s resolver, which is identity today
// (same as the preview). When a project-aware resolver lands, copy-out inherits
// it with no change here.

import type { EditorState } from '@codemirror/state';
import { renderMarkdown } from '../preview/markdown';

export type ClipboardPayload = { text: string; html: string };

/**
 * Join every non-empty selection range into one Markdown string, in document
 * order, separated by newlines. Returns null when nothing is selected so the
 * caller can defer to the editor's default copy behaviour (which copies the
 * current line) rather than writing an empty clipboard.
 */
export function selectionMarkdown(state: EditorState): string | null {
  const parts: string[] = [];
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    parts.push(state.sliceDoc(range.from, range.to));
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/** Build the dual-write payload for a Markdown string. */
export function buildClipboardPayload(md: string): ClipboardPayload {
  return { text: md, html: renderMarkdown(md) };
}
