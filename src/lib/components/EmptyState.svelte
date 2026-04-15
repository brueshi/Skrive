<script lang="ts">
  // Shown when no project is loaded. Two paths forward: open an existing
  // directory as a project, or create a new directory via the NewProjectDialog.
  // The eventual welcome screen with recent-projects list is a later polish
  // pass, but the two-button shape is already where we want it to be.

  import { project } from "$lib/stores/project.svelte";
  import { pickProjectDirectory } from "$lib/dialog";
  import { formatError } from "$lib/errors";
  import NewProjectDialog from "./NewProjectDialog.svelte";

  let error = $state<string | null>(null);
  let busy = $state(false);
  let showNewDialog = $state(false);

  async function handleOpen() {
    error = null;
    busy = true;
    try {
      const path = await pickProjectDirectory();
      if (path) {
        await project.openProject(path);
      }
    } catch (e) {
      error = formatError(e);
    } finally {
      busy = false;
    }
  }

  function handleNew() {
    error = null;
    showNewDialog = true;
  }
</script>

<div class="empty-state">
  <div class="inner">
    <h1>Skrive</h1>
    <p class="tagline">Write seriously.</p>
    <div class="actions">
      <button
        type="button"
        class="primary"
        onclick={handleOpen}
        disabled={busy}
      >
        {busy ? "Opening…" : "Open project…"}
      </button>
      <button
        type="button"
        class="secondary"
        onclick={handleNew}
        disabled={busy}
      >
        Create new project…
      </button>
    </div>
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>
</div>

{#if showNewDialog}
  <NewProjectDialog onClose={() => (showNewDialog = false)} />
{/if}

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

  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  button {
    padding: 0.625rem 1.5rem;
    font: inherit;
    font-size: 0.9375rem;
    border-radius: 4px;
    cursor: pointer;
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  button.primary {
    border: 1px solid var(--skrive-fg);
    background: transparent;
    color: var(--skrive-fg);
  }

  button.primary:hover:not(:disabled) {
    background-color: var(--skrive-fg);
    color: var(--skrive-bg);
  }

  button.secondary {
    border: 1px solid var(--skrive-rule);
    background: transparent;
    color: var(--skrive-muted);
  }

  button.secondary:hover:not(:disabled) {
    border-color: var(--skrive-fg);
    color: var(--skrive-fg);
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
