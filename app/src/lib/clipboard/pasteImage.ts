// Pure helpers for pasting a binary image into the project (SKR-175). Path,
// name, link, and encoding logic only — picking the image off the clipboard
// lives in the bespoke surface (lib/blocksurface/surface.ts), and the IPC
// write + editor insertion are split across the surface's registered paste
// delegate (components/editor/block/BlockEditor.tsx) and the project store
// (stores/project.ts, `pasteImageAsset`).
//
// A pasted image is written to a sibling `assets/` folder next to the active
// document, and the inserted Markdown link is relative to that document.

// Folder (relative to the document) that pasted images are written into.
const ASSETS_DIR = 'assets';

// Clipboard image MIME -> file extension. Anything not listed isn't treated
// as a pasteable image, so the paste falls through to other handling.
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp'
};

/** Map a clipboard image MIME type to a file extension, or null if unknown. */
export function imageExtension(mimeType: string): string | null {
  return IMAGE_EXTENSIONS[mimeType.trim().toLowerCase()] ?? null;
}

/** Directory portion of a project-relative path; '' for a root-level file. */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i >= 0 ? relPath.slice(0, i) : '';
}

export type ImagePasteTarget = {
  /** Project-relative path to write the bytes to (forward-slash). */
  writePath: string;
  /** Markdown link target, relative to the document. */
  linkPath: string;
};

/**
 * Resolve where a pasted image lands. `docPath` is the active document's
 * project-relative path; the image goes in a sibling `assets/` folder, and the
 * link is that folder relative to the document.
 */
export function imagePasteTarget(docPath: string, filename: string): ImagePasteTarget {
  const dir = dirOf(docPath);
  const linkPath = `${ASSETS_DIR}/${filename}`;
  return {
    writePath: dir ? `${dir}/${linkPath}` : linkPath,
    linkPath
  };
}

/**
 * Collision-resistant, link-safe filename for a pasted image. No spaces, so
 * the Markdown link needs no escaping. `now` is injectable for tests.
 */
export function pastedImageFilename(ext: string, now: number = Date.now()): string {
  return `pasted-image-${now}.${ext}`;
}

/** The Markdown image link inserted for a pasted image. */
export function imageMarkdownLink(linkPath: string): string {
  return `![](${linkPath})`;
}

// Bytes are read off the clipboard/drop as a plain array; the shell's binary
// write IPC (`fs:writeBinaryFile`) takes base64, so the store's write delegate
// needs an encoder. Chunked so a multi-megabyte screenshot doesn't blow the
// call stack the way `String.fromCharCode(...bytes)` would as one spread call.
const BASE64_CHUNK = 0x8000;

/** Encode raw bytes as base64, for the binary-file write IPC. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}
