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
// Update cadence: there is deliberately NO debounce here. The `body` prop
// is the project-store snapshot, and every writer of that snapshot already
// coalesces keystroke bursts before it lands — the Text surface via
// Editor.tsx's SYNC_DEBOUNCE_MS (250ms), the Rich surface via its own
// snapshot debounce. A second debounce in this component used to sit on
// top of that (150ms, a relic of the era when `body` updated per
// keystroke); since the upstream cadence was already coarser than its
// window it coalesced nothing and was pure added latency. If a
// per-keystroke `body` writer is ever reintroduced, restore coalescing at
// the writer, not here.
//
// Link click handling: external schemes go through the OS via the
// `links:openExternal` IPC. Internal relative links are routed via the
// `onInternalLink` callback (Phase 6 wires this through to the project
// store; Phase 2 ignores them).

import { useMemo, useRef } from 'react';
import { renderMarkdown } from '../../lib/preview/markdown';
import { skriveAssetResolver } from '../../lib/preview/imageResolver';
import { isSafeUrl } from '../../lib/security/urls';
import { OutlineRail } from './OutlineRail';
import { useProjectStore } from '../../stores/project';

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

// `#fragment` links are handled separately (scroll within the preview),
// so they are intentionally *not* treated as external here — the caller
// checks for them first.
function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

// Whole heading elements in renderer output. Headings cannot nest, and the
// renderer escapes `<` inside code, so a lazy match up to the matching
// closing tag is unambiguous.
const HEADING_TAG_RE = /<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi;

/**
 * A key that changes iff the heading *structure* of rendered HTML changes
 * — count, levels, ids, or inner content of headings. Paragraph-only
 * edits leave it stable, so the outline rail can skip its DOM re-measure
 * on the typical typing render. Built by concatenating the raw heading
 * tags: deliberately conservative (an inline-markup toggle inside a
 * heading changes the key), because a spurious re-measure is cheap and a
 * missed one means stale ticks.
 */
export function headingStructureKey(html: string): string {
  return (html.match(HEADING_TAG_RE) ?? []).join('\n');
}

export function Preview({
  body,
  filePath = null,
  projectRoot = '',
  onInternalLink,
  showRail: showRailRequested = false
}: Props) {
  // Focus mode strips the ambient readouts (SKR-52). Gated here, where the rail
  // is actually mounted, rather than in the caller's `showRail` — that way the
  // rail's heading scan and ResizeObserver stop with it no matter who mounts
  // this, and a second caller can't forget.
  const focusMode = useProjectStore((s) => s.focusMode);
  const showRail = showRailRequested && !focusMode;
  const html = useMemo(
    () =>
      renderMarkdown(body, {
        context: { projectRoot, filePath },
        resolver: skriveAssetResolver
      }),
    [body, projectRoot, filePath]
  );
  // Structure-sensitive invalidation key for the rail: paragraph edits
  // re-render the HTML but keep this key (and thus the rail's heading
  // re-measure) untouched. Only computed when a rail is mounted to see it.
  const railKey = useMemo(
    () => (showRail ? headingStructureKey(html) : ''),
    [showRail, html]
  );
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
    const target = e.target as Element | null;
    const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.getAttribute('href');
    if (!href) return;

    // Refuse a disallowed scheme before ANY other branch, modifier-clicks
    // included (SKR-187 / F29). The modifier bail below hands the click to the
    // browser, which would navigate a `javascript:` href in the app's own origin
    // — the host's scheme allowlist never sees it, because `openExternal` is
    // never called. Preview renders file markdown with `allowDangerousHtml`, so
    // the anchor can come from raw HTML in the document as easily as from a link.
    if (!isSafeUrl(href)) {
      e.preventDefault();
      return;
    }

    // Modifier-clicks (open in new window etc.) aren't meaningful in a
    // single-window app but leave them to the browser anyway.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

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
        // Programmatically focusable, never in the Tab order: cycling into preview
        // focuses the scroller so Space / PageDown act on the prose (SKR-183).
        tabIndex={-1}
      >
        <div
          className="preview-inner"
          ref={innerRef}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      {showRail && (
        <OutlineRail
          scrollerRef={scrollerRef}
          contentRef={innerRef}
          renderKey={railKey}
        />
      )}
    </div>
  );
}
