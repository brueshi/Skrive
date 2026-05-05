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

type Props = {
  body: string;
  /**
   * Called when the user clicks an internal (relative) link in the
   * rendered HTML. Phase 6 wires this through to the project store;
   * Phase 2 leaves it as a no-op default.
   */
  onInternalLink?: (href: string) => void;
};

const DEBOUNCE_MS = 150;

function isExternalHref(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith('//') ||
    href.startsWith('#')
  );
}

export function Preview({ body, onInternalLink }: Props) {
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

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    // Modifier-clicks (open in new window etc.) aren't meaningful in a
    // single-window app but leave them to the browser anyway.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const target = e.target as Element | null;
    const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.getAttribute('href');
    if (!href) return;

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
    <div className="preview" role="document" onClick={handleClick}>
      <div className="preview-inner" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
