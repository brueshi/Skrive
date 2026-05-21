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
import { renderMarkdown } from '../../lib/preview/markdown';
import { PreviewOutlineRail } from './PreviewOutlineRail';

type Props = {
  body: string;
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

export function Preview({ body, onInternalLink, showRail = false }: Props) {
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

  const html = useMemo(() => renderMarkdown(debouncedBody), [debouncedBody]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

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
    <div className="preview-host">
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
