<script lang="ts">
  // Read-only markdown preview pane. Renders via the marked pipeline and
  // styles the output to match the editor's typographic scale so a user
  // flipping between raw, split, and preview modes sees the same line lengths
  // and text weights across all three.
  //
  // The rendered HTML is inserted via `{@html}`. We consider file content
  // trusted input (see markdown.ts for the justification). If that ever
  // changes, sanitize in the pipeline, not here.
  //
  // Debouncing note: the body prop updates on every keystroke. Re-running
  // marked on each keystroke produces visible flicker when the user types
  // a character that temporarily breaks an emphasis span (e.g. a trailing
  // space inside `**bold **`, which CommonMark treats as not-bold until the
  // text is typed further). A 150ms debounce coalesces keystroke bursts into
  // a single render, so those transient states never reach the DOM.
  //
  // Link click handling: rendered markdown links are `<a href="...">` in the
  // DOM. A bare click would navigate the webview — SvelteKit treats any
  // same-origin click as a route change and fires a 404 for anything that
  // isn't `/`. We intercept at the container level: relative markdown links
  // route through `project.openTab`; external schemes open in the user's
  // browser via the opener plugin.

  import { onDestroy } from "svelte";
  import { renderMarkdown } from "./markdown";
  import { project } from "$lib/stores/project.svelte";
  import { notify } from "$lib/stores/notifications.svelte";
  import { formatError } from "$lib/errors";
  import { openUrl } from "@tauri-apps/plugin-opener";

  type Props = {
    body: string;
  };

  let { body }: Props = $props();

  function isExternalHref(href: string): boolean {
    return (
      /^[a-z][a-z0-9+.-]*:/i.test(href) ||
      href.startsWith("//") ||
      href.startsWith("#")
    );
  }

  function resolveRelativeHref(
    sourcePath: string,
    href: string,
  ): string | null {
    // Build the source file's parent segments.
    const sourceSegments = sourcePath.split("/").filter(Boolean);
    sourceSegments.pop(); // drop the file name
    const linkSegments = href.split("/").filter(Boolean);
    const combined = [...sourceSegments];
    for (const seg of linkSegments) {
      if (seg === ".") continue;
      if (seg === "..") {
        if (combined.length === 0) return null; // would escape project root
        combined.pop();
        continue;
      }
      combined.push(seg);
    }
    return combined.join("/");
  }

  function handleClick(e: MouseEvent) {
    // Modifier-clicks (open in new window etc.) aren't meaningful in a
    // single-window Tauri app but leave them to the browser anyway.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const target = e.target as Element | null;
    const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    if (!href) return;

    if (isExternalHref(href)) {
      // Open externals (http://, mailto:, etc.) in the system default
      // handler rather than the webview, which can't nav-navigate
      // cross-origin cleanly in SPA mode anyway.
      e.preventDefault();
      void openUrl(href).catch((err) => {
        notify.error(`Couldn't open ${href}: ${formatError(err)}`, err);
      });
      return;
    }

    // Internal relative link — must resolve against the active tab's
    // path or we don't know where we are.
    const sourcePath = project.activeTab?.path;
    if (!sourcePath) return;
    const resolved = resolveRelativeHref(sourcePath, href);
    if (!resolved) return;
    // Only .md / .markdown files are openable in Skrive today. Non-
    // markdown targets (images, pdfs, etc.) fall through — the default
    // navigation would 404 too, but that's a broader follow-up.
    if (!/\.(md|markdown)$/i.test(resolved)) return;

    e.preventDefault();
    void project.openTab(resolved).catch((err) => {
      notify.error(
        `Couldn't open ${resolved}: ${formatError(err)}`,
        err,
      );
    });
  }

  const DEBOUNCE_MS = 150;
  let debouncedBody = $state("");
  let pending: ReturnType<typeof setTimeout> | null = null;
  let mounted = false;

  $effect(() => {
    // Read `body` so the effect re-runs when it changes.
    const next = body;
    if (!mounted) {
      // First pass — take the initial body immediately so the preview
      // renders the opened file with no delay.
      mounted = true;
      debouncedBody = next;
      return;
    }
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      debouncedBody = next;
      pending = null;
    }, DEBOUNCE_MS);
  });

  onDestroy(() => {
    if (pending) clearTimeout(pending);
  });

  let html = $derived(
    renderMarkdown(debouncedBody, {
      projectRoot: project.manifest?.root ?? "",
      filePath: project.activeTab?.path ?? null,
    }),
  );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="preview" role="document" onclick={handleClick}>
  <div class="preview-inner">
    {@html html}
  </div>
</div>

<style>
  .preview {
    height: 100%;
    width: 100%;
    overflow-y: auto;
    background: var(--skrive-bg);
    color: var(--skrive-fg);
  }

  .preview-inner {
    max-width: 42rem;
    margin: 0 auto;
    padding: 2.5rem 2rem 6rem;
    /* Track the editor's font choice so split view stays coherent.
       Size + line-height stay as relative defaults — the preview's
       heading scale cascades from `font-size: 1rem` and changing it
       would resize every heading too. The Settings sliders only
       affect the raw editor surface today. */
    font-family: var(--skrive-editor-font);
    font-size: 1rem;
    line-height: 1.65;
  }

  .preview-inner :global(h1),
  .preview-inner :global(h2),
  .preview-inner :global(h3),
  .preview-inner :global(h4),
  .preview-inner :global(h5),
  .preview-inner :global(h6) {
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.25;
    margin: 1.75em 0 0.5em;
    color: var(--skrive-fg);
  }

  .preview-inner :global(h1) {
    font-size: 1.85rem;
    margin-top: 0;
  }
  .preview-inner :global(h2) {
    font-size: 1.45rem;
  }
  .preview-inner :global(h3) {
    font-size: 1.2rem;
  }
  .preview-inner :global(h4),
  .preview-inner :global(h5),
  .preview-inner :global(h6) {
    font-size: 1.05rem;
  }

  .preview-inner :global(p) {
    margin: 0 0 1em;
  }

  .preview-inner :global(a) {
    color: var(--skrive-link);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }

  .preview-inner :global(strong) {
    font-weight: 600;
  }

  .preview-inner :global(em) {
    font-style: italic;
  }

  .preview-inner :global(ul),
  .preview-inner :global(ol) {
    margin: 0 0 1em;
    padding-left: 1.5em;
  }

  .preview-inner :global(li) {
    margin-bottom: 0.25em;
  }

  .preview-inner :global(blockquote) {
    margin: 1em 0;
    padding: 0.25em 0 0.25em 1em;
    border-left: 2px solid var(--skrive-rule);
    color: var(--skrive-muted);
  }

  .preview-inner :global(hr) {
    border: 0;
    border-top: 1px solid var(--skrive-rule);
    margin: 2em 0;
  }

  .preview-inner :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: var(--skrive-rule);
    padding: 0.1em 0.35em;
    border-radius: 3px;
  }

  .preview-inner :global(pre) {
    background: var(--skrive-rule);
    padding: 1em;
    border-radius: 4px;
    overflow-x: auto;
    margin: 1em 0;
    line-height: 1.5;
  }

  .preview-inner :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: 0.85rem;
  }

  .preview-inner :global(img) {
    max-width: 100%;
    height: auto;
  }

  .preview-inner :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    font-size: 0.95em;
  }

  .preview-inner :global(th),
  .preview-inner :global(td) {
    border-bottom: 1px solid var(--skrive-rule);
    padding: 0.5em 0.75em;
    text-align: left;
  }

  .preview-inner :global(th) {
    font-weight: 600;
  }
</style>
