<script lang="ts">
  // Create-new-project modal. Mirrors the Obsidian vault-creation flow: the
  // user picks a parent location via the system directory picker and types
  // a name. Skrive creates the folder and opens it as the active project.
  //
  // Surface treatment is deliberately stark — a 2px foreground-color border
  // instead of a drop shadow, per the design system's "borders, not shadows"
  // principle. No rounded panels. Paper-on-paper elevation.

  import { pickProjectDirectory } from "$lib/dialog";
  import { project } from "$lib/stores/project.svelte";

  type Props = {
    onClose: () => void;
  };
  let { onClose }: Props = $props();

  let name = $state("Untitled");
  let location = $state<string | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function browseLocation() {
    const path = await pickProjectDirectory();
    if (path) {
      location = path;
    }
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || !location) return;
    error = null;
    busy = true;
    try {
      await project.createProject(location, trimmed);
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget && !busy) {
      onClose();
    }
  }

  function handleKey(e: KeyboardEvent) {
    if (busy) return;
    if (e.key === "Escape") {
      onClose();
    }
    if (e.key === "Enter" && name.trim() && location) {
      handleCreate();
    }
  }
</script>

<svelte:window onkeydown={handleKey} />

<div
  class="backdrop"
  onclick={handleBackdropClick}
  role="presentation"
>
  <div class="dialog" role="dialog" aria-labelledby="dialog-title" aria-modal="true">
    <h2 id="dialog-title">Create new project</h2>
    <p class="desc">Pick a location and a name. Skrive will create the folder.</p>

    <div class="field">
      <label for="project-name">Name</label>
      <input
        id="project-name"
        type="text"
        bind:value={name}
        disabled={busy}
        placeholder="Untitled"
      />
    </div>

    <div class="field">
      <label for="project-location">Location</label>
      <div class="location-row">
        <input
          id="project-location"
          type="text"
          readonly
          value={location ?? ""}
          placeholder="Click Browse to choose…"
        />
        <button type="button" onclick={browseLocation} disabled={busy}>Browse…</button>
      </div>
    </div>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="actions">
      <button type="button" class="secondary" onclick={onClose} disabled={busy}>
        Cancel
      </button>
      <button
        type="button"
        class="primary"
        onclick={handleCreate}
        disabled={!name.trim() || !location || busy}
      >
        {busy ? "Creating…" : "Create"}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  }

  .dialog {
    background: var(--skrive-bg);
    border: 2px solid var(--skrive-fg);
    padding: 1.75rem 2rem;
    width: 28rem;
    max-width: calc(100vw - 2rem);
  }

  h2 {
    margin: 0 0 0.25rem;
    font-size: 1.125rem;
    color: var(--skrive-fg);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .desc {
    margin: 0 0 1.5rem;
    font-size: 0.8125rem;
    color: var(--skrive-muted);
  }

  .field {
    margin-bottom: 1rem;
  }

  label {
    display: block;
    font-size: 0.6875rem;
    color: var(--skrive-muted);
    margin-bottom: 0.375rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  input[type="text"] {
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--skrive-rule);
    border-radius: 4px;
    background: var(--skrive-bg);
    color: var(--skrive-fg);
    font: inherit;
    font-size: 0.875rem;
    box-sizing: border-box;
    transition: border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  input[type="text"]:focus {
    outline: none;
    border-color: var(--skrive-fg);
  }

  input[type="text"]:disabled {
    opacity: 0.5;
  }

  input[type="text"][readonly] {
    color: var(--skrive-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8125rem;
  }

  .location-row {
    display: flex;
    gap: 0.5rem;
  }

  .location-row input {
    flex: 1;
    min-width: 0;
  }

  .location-row button {
    flex-shrink: 0;
  }

  .error {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    color: #a84030;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1.5rem;
  }

  button {
    padding: 0.5rem 1rem;
    border-radius: 4px;
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
    border: 1px solid var(--skrive-fg);
    background: transparent;
    color: var(--skrive-fg);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  button.secondary {
    border-color: var(--skrive-rule);
    color: var(--skrive-muted);
  }

  button.secondary:not(:disabled):hover {
    border-color: var(--skrive-fg);
    color: var(--skrive-fg);
  }

  button.primary:not(:disabled):hover {
    background: var(--skrive-fg);
    color: var(--skrive-bg);
  }
</style>
