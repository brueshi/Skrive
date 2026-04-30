// Markdown pipeline for the preview pane. Uses `marked` with GFM enabled
// and line-break-sensitive parsing so the preview matches what the user sees
// in most editors.
//
// Phase 2.1 scope: this is the *basic* preview pipeline. It is deliberately
// not the same thing as the inline preview decorations from Phase 2.2 — the
// split-view preview pane renders a full HTML tree on every edit, while
// inline preview edits CodeMirror decorations in place. Two distinct systems.
//
// Frontmatter handling: the preview always strips a leading `---...---`
// block before rendering. Files opened from disk already arrive with their
// frontmatter stripped by the Rust core, so the strip is a no-op for them.
// The real job is handling frontmatter that the user has *typed or pasted*
// directly into the editor — we treat that content as structured metadata
// for display purposes regardless of whether the auto-save extraction path
// has absorbed it into the structured store yet. The reader's view should
// never include YAML.
//
// Sanitization note: the content we render comes exclusively from files the
// user has opened on their own disk. We treat it as trusted input and do not
// strip HTML. If we ever render Markdown from the network (e.g. importers
// pulling from Obsidian Publish), that caller must sanitize before handing
// content to this module.

import { marked } from "marked";
import type { Tokens } from "marked";
import { resolveImageSrc, type ImageContext } from "$lib/imageSrc";

marked.setOptions({
  gfm: true,
  breaks: false,
});

// Per-call context for the image renderer below. Marked is synchronous
// in our config, so this module-level variable is safe — there's no
// concurrent parse to clobber it. We set before each call and clear
// after, which keeps `currentContext` from leaking across renders if a
// caller forgets to pass one.
let currentContext: ImageContext = { projectRoot: "", filePath: null };

// Override only the image renderer; everything else falls through to
// marked's default. The asset-URL conversion is what makes the rendered
// `<img>` actually load — without it, the browser can't fetch arbitrary
// disk paths from a Tauri webview. See `$lib/imageSrc.ts`.
marked.use({
  renderer: {
    image({ href, title, text }: Tokens.Image): string {
      const resolved = resolveImageSrc(href, currentContext);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<img src="${escapeAttr(resolved)}" alt="${escapeAttr(text)}"${titleAttr}>`;
    },
  },
});

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Strip a leading YAML frontmatter block from a body string, matching the
 * same fence rules the Rust `frontmatter::parse` implements:
 *
 *   - The opening fence must be `---` at byte zero followed by `\n` or `\r\n`.
 *   - The closing fence is the first line whose trimmed content is exactly
 *     `---` or `...`.
 *   - An unterminated opening fence is *not* stripped — we'd rather render
 *     the raw `---` than silently eat the whole document.
 *
 * When the body has no fence, the original string is returned unchanged.
 */
export function stripLeadingFrontmatter(source: string): string {
  let prefixLen: number;
  if (source.startsWith("---\n")) {
    prefixLen = 4;
  } else if (source.startsWith("---\r\n")) {
    prefixLen = 5;
  } else {
    return source;
  }

  const rest = source.slice(prefixLen);
  const lines = rest.split("\n");
  let charsConsumed = 0;
  for (const line of lines) {
    charsConsumed += line.length + 1; // +1 for the `\n` we split on
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "---" || trimmed === "...") {
      return rest.slice(charsConsumed);
    }
  }

  // No closing fence — leave the source alone so we don't lose content.
  return source;
}

export function renderMarkdown(body: string, ctx?: ImageContext): string {
  // `marked.parse` returns a string synchronously when no async extensions
  // are registered, which is our case. The overload returns `string | Promise`,
  // so we cast.
  currentContext = ctx ?? { projectRoot: "", filePath: null };
  try {
    const stripped = stripLeadingFrontmatter(body);
    return marked.parse(stripped) as string;
  } finally {
    currentContext = { projectRoot: "", filePath: null };
  }
}
