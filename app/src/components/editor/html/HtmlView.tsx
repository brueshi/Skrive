// Read-only HTML viewer (SKR-205). Renders an arbitrary `.html` file faithfully
// without ever running its scripts or exposing the app's IPC bridge to it.
//
// Isolation model — why an iframe, not `dangerouslySetInnerHTML` like Preview:
// in this WKWebView, `window.skrive` is a *filesystem capability* (read/write
// project files, open external URLs). Injecting untrusted file HTML into our own
// document would put that entire capability boundary on a sanitizer being
// exhaustive — one missed `<script>` vector is full filesystem access. A
// sandboxed iframe makes script execution impossible *by construction* and gives
// the content an opaque origin, so it cannot see `window.skrive` at all. That is
// a stronger and simpler guarantee than any sanitizer, so we carry no sanitizer
// dependency: the sandbox is the boundary.
//
//   - `sandbox=""` (empty): maximal restrictions — no scripts, no same-origin, no
//     forms, no popups, no top-navigation. Remote resource loads (img/css/font)
//     are unaffected by the sandbox, which is what we want.
//   - The injected CSP is defense-in-depth (and intent-documenting): scripts and
//     plugins are denied outright; images, styles, fonts, and media may load from
//     anywhere. Remote loads are allowed by product decision — a faithful render
//     of saved pages is worth more than a phone-home guard on a file the user
//     already has, and there is no script to weaponize the loads.
//
// Known v1 limitations (honest, not silent): links inside the document are inert
// (the sandbox blocks navigation), and *relative* resource URLs don't resolve
// (an `about:srcdoc` document has no base) — absolute and data: URLs render.

import { useMemo } from 'react';
import './HtmlView.css';

type Props = {
  /** Raw HTML bytes of the file, rendered verbatim inside the sandbox. */
  body: string;
  /** Accessible title for the viewer frame. */
  ariaLabel?: string;
};

// Scripts and plugins denied; images/styles/fonts/media allowed from anywhere so
// remote resources in a saved page still render. `base-uri`/`form-action` 'none'
// close off the remaining active-content vectors an empty sandbox already blocks.
const VIEWER_CSP = [
  "default-src 'unsafe-inline' data: blob: https: http:",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

const HEAD_OPEN = /<head[^>]*>/i;
const HTML_OPEN = /<html[^>]*>/i;

/** Build the iframe `srcdoc` from the file's HTML with the CSP meta injected as
 *  the first thing the parser sees in `<head>`. Handles the three shapes a file
 *  can take: a full document with a `<head>`, a document with `<html>` but no
 *  head, and a bare fragment. */
export function buildViewerDocument(body: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}">`;
  if (HEAD_OPEN.test(body)) {
    return body.replace(HEAD_OPEN, (open) => `${open}${meta}`);
  }
  if (HTML_OPEN.test(body)) {
    return body.replace(HTML_OPEN, (open) => `${open}<head>${meta}</head>`);
  }
  return `<!DOCTYPE html><html><head>${meta}</head><body>${body}</body></html>`;
}

export function HtmlView({ body, ariaLabel = 'HTML preview' }: Props): React.ReactElement {
  const srcDoc = useMemo(() => buildViewerDocument(body), [body]);
  return (
    <div className="html-view">
      {/* srcDoc is set via React, which escapes the attribute value; the empty
          sandbox is the security boundary. */}
      <iframe
        className="html-view-frame"
        title={ariaLabel}
        srcDoc={srcDoc}
        sandbox=""
      />
    </div>
  );
}
