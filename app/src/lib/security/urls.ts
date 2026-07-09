// The single allowlist for URLs that may become a navigable attribute (`href`,
// `src`) or be handed to the host to open. Skrive's trust model is built for
// LOCAL FILES; the clipboard, and any document authored elsewhere, is external
// input crossing that boundary (SKR-187 / F29).
//
// Allowlist, not denylist: a scheme nobody enumerated is refused rather than
// waved through. `javascript:` and `vbscript:` execute; `data:` can carry
// `text/html` and executes on navigation; `file:` reads the local disk. Nothing
// in a note needs any of them.
//
// A pasted `data:image/...` is refused along with the rest. That costs nothing
// in practice: a real image paste carries an image FLAVOR on the clipboard and
// is claimed by the image-item path (SKR-175) long before HTML conversion runs,
// so the only `data:` images reaching here are ones inlined in a page's markup.
//
// The host enforces the same policy independently, in Swift
// (`ExternalLink.allowedSchemes`), so a link can never drive `NSWorkspace.open`
// with an arbitrary scheme. This module is the renderer-side half of that pair.
// Both exist on purpose: neither is allowed to be the only check.

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'skrive:']);

/** A scheme is `alpha *( alpha / digit / "+" / "-" / "." ) ":"` (RFC 3986). */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Normalize the way a browser does before resolving a URL, so an obfuscated
 * scheme can't slip past the check and then execute anyway. Browsers strip ALL
 * tabs and newlines from a URL wherever they appear, and trim leading/trailing
 * C0 controls and spaces — which is why `java\tscript:alert(1)` and
 * `\njavascript:alert(1)` both navigate. Decide on the string the browser will
 * actually act on, never on the raw one.
 */
function normalize(raw: string): string {
  // eslint-disable-next-line no-control-regex -- C0 controls are exactly what we must strip.
  return raw.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
}

/**
 * Whether `raw` is safe to place in a navigable attribute or hand to the host.
 *
 * Safe: an allowed absolute scheme, a protocol-relative `//host/path` (which
 * resolves to http/https), a fragment, and any relative path — relative links
 * are how a note points at its neighbour, and they never carry a scheme.
 */
export function isSafeUrl(raw: string): boolean {
  const url = normalize(raw);
  if (url === '') return false;
  const scheme = SCHEME_RE.exec(url);
  if (!scheme) return true; // relative path, or `#fragment`
  return ALLOWED_SCHEMES.has(scheme[0]!.toLowerCase());
}
