// Read-only markdown preview pane. Renders via the marked pipeline and
// styles the output to match the editor's typographic scale so a user
// flipping between raw, split, and preview modes sees the same line
// lengths and text weights across all three.
//
// The rendered HTML is inserted via `dangerouslySetInnerHTML`. We
// consider file content trusted input (see markdown.ts for the
// justification). If that ever changes, sanitize in the pipeline, not
// here.
//
// Debouncing: the body prop updates on every keystroke. Re-running marked
// on each keystroke produces visible flicker when the user types a
// character that temporarily breaks an emphasis span. A 150ms debounce
// coalesces keystroke bursts into a single render.
//
// Link click handling: external schemes go through the OS via the
// `links:openExternal` IPC. Internal relative links are routed via the
// `onInternalLink` callback (Phase 6 wires this through to the project
// store; Phase 2 ignores them).

import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown, stripLeadingFrontmatter } from '../../lib/preview/markdown';
import { skriveAssetResolver } from '../../lib/preview/imageResolver';
import { buildClipboardPayload } from '../../lib/clipboard/copyOut';
import { IconCopy } from '../icons/IconCopy';
import { IconCheck } from '../icons/IconCheck';
import { PreviewOutlineRail } from './PreviewOutlineRail';

const COPIED_FEEDBACK_MS = 1600;

type Props = {
  body: string;
  /**
   * Active document's project-relative path, used to resolve relative image
   * URLs against the project (via the skrive-asset protocol).
   */
  filePath?: string | null;
  /** Project root, forwarded into the image resolver's context. */
  projectRoot?: string;
  /**
   * Called when the user clicks an internal (relative) link in the
   * rendered HTML. Phase 6 wires this through to the project store;
   * Phase 2 leaves it as a no-op default.
   */
  onInternalLink?: (href: string) => void;
  /**
   * Show the outline rail down the right edge. Only enabled in
   * preview-only layout (the rail navigates the rendered document, not
   * the editor); the caller gates this on layout mode + preference.
   */
  showRail?: boolean;
};

const DEBOUNCE_MS = 150;

// `#fragment` links are handled separately (scroll within the preview),
// so they are intentionally *not* treated as external here — the caller
// checks for them first.
function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

export function Preview({
  body,
  filePath = null,
  projectRoot = '',
  onInternalLink,
  showRail = false
}: Props) {
  const [debouncedBody, setDebouncedBody] = useState(body);
  const mountedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      setDebouncedBody(body);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDebouncedBody(body);
      timerRef.current = null;
    }, DEBOUNCE_MS);
  }, [body]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const html = useMemo(
    () =>
      renderMarkdown(debouncedBody, {
        context: { projectRoot, filePath },
        resolver: skriveAssetResolver
      }),
    [debouncedBody, projectRoot, filePath]
  );
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

  // Copy-out for preview mode. The editor's copy handler doesn't cover this
  // surface, and the browser's native copy of the rendered DOM drags the
  // theme background into rich targets. This button copies the whole document
  // as a clean dual-write payload built from the renderer, not the DOM, so
  // there's no styling to bleed. Frontmatter is stripped to match what the
  // preview shows.
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const documentBody = stripLeadingFrontmatter(body).trim();

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function copyDocument() {
    const { text, html: rendered } = buildClipboardPayload(documentBody);
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([rendered], { type: 'text/html' })
        })
      ]);
    } catch {
      // Some environments refuse rich clipboard writes; fall back to plain.
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.warn('[skrive] copy to clipboard failed:', err);
        return;
      }
    }
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }

  // Scroll the preview to a same-document heading. An empty fragment
  // ("#") is the conventional "back to top". Fragments may be percent-
  // encoded by the renderer for non-ASCII slugs, so decode before
  // matching the `id` we assigned in markdown.ts.
  function scrollToFragment(rawFragment: string) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (rawFragment === '') {
      scroller.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    let id = rawFragment;
    try {
      id = decodeURIComponent(rawFragment);
    } catch {
      // Malformed escape — fall back to the raw fragment.
    }
    const target = scroller.querySelector(`#${CSS.escape(id)}`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    // Modifier-clicks (open in new window etc.) aren't meaningful in a
    // single-window app but leave them to the browser anyway.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const target = e.target as Element | null;
    const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.getAttribute('href');
    if (!href) return;

    // Same-document anchor: scroll the preview, never leave the app.
    if (href.startsWith('#')) {
      e.preventDefault();
      scrollToFragment(href.slice(1));
      return;
    }

    if (isExternalHref(href)) {
      e.preventDefault();
      void window.skrive.links.openExternal(href).catch((err) => {
        console.warn(`[skrive] couldn't open ${href}:`, err);
      });
      return;
    }

    // Internal relative link — Phase 6 wires this through to the
    // project store. Phase 2 calls the callback if provided, else
    // does nothing (no project store exists yet).
    if (onInternalLink) {
      e.preventDefault();
      onInternalLink(href);
    }
  }

  return (
    <div className={`preview-host${showRail ? ' has-rail' : ''}`}>
      <div
        className="preview"
        role="document"
        onClick={handleClick}
        ref={scrollerRef}
      >
        <div
          className="preview-inner"
          ref={innerRef}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      {documentBody !== '' && (
        <button
          type="button"
          className={`preview-copy${copied ? ' copied' : ''}`}
          title={copied ? 'Copied' : 'Copy document'}
          aria-label={
            copied ? 'Document copied to clipboard' : 'Copy document to clipboard'
          }
          onClick={copyDocument}
        >
          {/* Both glyphs are stacked and crossfaded in CSS; a brief blur
              bridges the copy -> check swap so it reads as one continuous
              state change rather than a hard cut. */}
          <span className="preview-copy-glyphs">
            <IconCopy size={16} className="preview-copy-glyph is-copy" />
            <IconCheck size={16} className="preview-copy-glyph is-check" />
          </span>
        </button>
      )}
      {showRail && (
        <PreviewOutlineRail
          scrollerRef={scrollerRef}
          contentRef={innerRef}
          renderKey={html}
        />
      )}
    </div>
  );
}
