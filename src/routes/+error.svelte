<script lang="ts">
  // SvelteKit error boundary. Any unknown route or thrown error lands
  // here — including the 404 you'd hit if a preview link or backlink
  // row slipped past the in-app click handlers and reached the router.
  //
  // This page is deliberately tiny and Skrive-shaped: a serif headline,
  // a monospace path readout, and one button that takes you back to
  // `/` where the workspace (or empty state) lives. No project chrome
  // is loaded here because +layout.ts is SSR=false and the error page
  // renders before the layout subtree mounts.

  import { page } from "$app/state";
  import { goto } from "$app/navigation";

  const status = $derived(page.status);
  const badPath = $derived(page.url.pathname);
  const message = $derived(
    status === 404
      ? "That file isn't somewhere Skrive knows about."
      : (page.error?.message ?? "Something went sideways."),
  );

  function goHome() {
    // `replaceState: true` so the bad URL doesn't linger in the back
    // stack — the user hit the error once and the back button should
    // skip over it.
    void goto("/", { replaceState: true });
  }
</script>

<div class="error-page">
  <div class="error-card">
    <div class="error-status">{status}</div>
    <h1 class="error-title">{message}</h1>
    {#if status === 404}
      <p class="error-path" title={badPath}>{badPath}</p>
    {/if}
    <button type="button" class="error-home" onclick={goHome}>
      Return to editor
    </button>
  </div>
</div>

<style>
  .error-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    background: var(--skrive-bg, #f6f2ea);
    color: var(--skrive-fg, #2d2a24);
    font-family:
      "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia,
      serif;
  }

  .error-card {
    max-width: 28rem;
    text-align: left;
  }

  .error-status {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--skrive-muted, #7a6f5e);
    margin-bottom: 0.75rem;
  }

  .error-title {
    font-size: 1.5rem;
    font-weight: 600;
    line-height: 1.3;
    margin: 0 0 0.75rem;
    letter-spacing: -0.01em;
  }

  .error-path {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--skrive-muted, #7a6f5e);
    background: color-mix(in srgb, currentColor 8%, transparent);
    padding: 0.35rem 0.55rem;
    border-radius: 3px;
    margin: 0 0 1.25rem;
    overflow-wrap: anywhere;
  }

  .error-home {
    background: var(--skrive-fg, #2d2a24);
    color: var(--skrive-bg, #f6f2ea);
    border: 1px solid var(--skrive-fg, #2d2a24);
    border-radius: 3px;
    font: inherit;
    font-size: 13px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    transition: opacity 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .error-home:hover {
    opacity: 0.85;
  }
</style>
