// Resolve a Markdown image URL into a webview-loadable URL.
//
// The editor's inline-image decoration and the preview pane's marked
// pipeline both face the same problem: an `![alt](attachments/foo.png)`
// in source is a *file-relative* path that the webview can't fetch
// directly. The asset protocol can serve any path within its scope, but
// the URL has to go through `convertFileSrc` first. This helper bundles
// the path math (resolve relative to the source file, fold `.`/`..`,
// prefix the project root) and the conversion step so both call sites
// share one code path — and one source of truth for what counts as
// "external, leave alone."

import { convertFileSrc } from "@tauri-apps/api/core";

export type ImageContext = {
  /** Absolute filesystem path to the project root, or empty when no project is open. */
  projectRoot: string;
  /** Project-relative path of the file currently being viewed/edited, or null. */
  filePath: string | null;
};

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * True when `url` is something we should not rewrite — an external URL
 * (`http://…`, `data:…`, already-converted `asset:…`), a protocol-
 * relative URL, or an in-document anchor.
 */
export function isExternalImageUrl(url: string): boolean {
  if (url.length === 0) return true;
  return SCHEME_RE.test(url) || url.startsWith("//") || url.startsWith("#");
}

export function resolveImageSrc(url: string, ctx: ImageContext): string {
  if (isExternalImageUrl(url)) return url;
  // Without a project root we can't build an absolute path. Hand back
  // the raw URL; load will fail and the alt text fallback fires.
  if (!ctx.projectRoot) return url;

  const filePath = ctx.filePath ?? "";
  const sourceDir = filePath.includes("/")
    ? filePath.slice(0, filePath.lastIndexOf("/"))
    : "";
  const combined = sourceDir ? `${sourceDir}/${url}` : url;

  const segments: string[] = [];
  for (const seg of combined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      segments.pop();
      continue;
    }
    // Markdown URLs encode spaces and special characters per CommonMark
    // (e.g. `![](path%20with%20spaces.png)`). The on-disk filename has
    // the decoded form, so decode each segment before composing the
    // filesystem path. Malformed encoding falls back to the raw segment
    // so we still try a load instead of throwing in render.
    try {
      segments.push(decodeURIComponent(seg));
    } catch {
      segments.push(seg);
    }
  }

  const absolute = `${ctx.projectRoot.replace(/\/$/, "")}/${segments.join("/")}`;
  return convertFileSrc(absolute);
}

/**
 * Convert a project-relative path (the form `copy_attachment` returns)
 * into a source-file-relative path (the form Markdown links use). When
 * a file at `chapters/draft.md` references the project's
 * `attachments/foo.png`, the link must read `../attachments/foo.png` so
 * any markdown reader — Skrive, GitHub, a static-site generator —
 * resolves it the same way.
 *
 * Returns the project-relative path unchanged when there's no source
 * file (e.g. drop happens before any tab is open).
 */
export function projectRelToSourceRel(
  projectRel: string,
  sourceFilePath: string | null,
): string {
  if (!sourceFilePath) return projectRel;

  const sourceSegs = sourceFilePath.split("/").filter(Boolean);
  sourceSegs.pop(); // drop the filename — directory part only
  const targetSegs = projectRel.split("/").filter(Boolean);

  let common = 0;
  while (
    common < sourceSegs.length &&
    common < targetSegs.length &&
    sourceSegs[common] === targetSegs[common]
  ) {
    common += 1;
  }

  const ups = sourceSegs.length - common;
  const downs = targetSegs.slice(common);
  const parts: string[] = [];
  for (let i = 0; i < ups; i += 1) parts.push("..");
  parts.push(...downs);
  return parts.join("/");
}
