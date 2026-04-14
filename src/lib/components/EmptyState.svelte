<script lang="ts">
  // Shown when no project is loaded. Single "Open project" button that calls
  // the system directory picker and asks the Rust core to scan the chosen path.
  // This is the entire v0.0 onboarding experience — the eventual welcome page
  // with recent-projects list is a later polish pass.

  import { project } from "$lib/stores/project.svelte";
  import { pickProjectDirectory } from "$lib/dialog";

  let error = $state<string | null>(null);
  let busy = $state(false);

  async function handleOpen() {
    error = null;
    busy = true;
    try {
      const path = await pickProjectDirectory();
      if (path) {
        await project.openProject(path);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="empty-state">
  <div class="inner">
    <h1>Skrive</h1>
    <p class="tagline">Write seriously.</p>
    <button type="button" onclick={handleOpen} disabled={busy}>
      {busy ? "Opening…" : "Open project…"}
    </button>
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>
</div>

<style>
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    width: 100vw;
  }

  .inner {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
    max-width: 32rem;
    padding: 2rem;
  }

  h1 {
    font-size: 4rem;
    font-weight: 600;
    letter-spacing: -0.04em;
    margin: 0;
    color: var(--skrive-fg);
  }

  .tagline {
    margin: 0;
    font-size: 1.0625rem;
    color: var(--skrive-muted);
    letter-spacing: 0.02em;
  }

  button {
    border: 1px solid var(--skrive-fg);
    background: transparent;
    color: var(--skrive-fg);
    padding: 0.625rem 1.5rem;
    font: inherit;
    font-size: 0.9375rem;
    border-radius: 4px;
    cursor: pointer;
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
    margin-top: 0.75rem;
  }

  button:hover:not(:disabled) {
    background-color: var(--skrive-fg);
    color: var(--skrive-bg);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .error {
    margin: 0;
    color: #a84030;
    font-size: 0.8125rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    max-width: 28rem;
    word-break: break-word;
  }
</style>
