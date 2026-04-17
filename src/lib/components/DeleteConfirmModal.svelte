<script lang="ts">
  // Delete confirmation modal for the sidebar.
  //
  // Shows the thing being deleted, a primary "Move to trash" button, a
  // cancel button, and a "Don't ask again" checkbox. The checkbox flips
  // `preferences.skipDeleteConfirmation`, which the sidebar consults
  // before opening this modal on subsequent deletes. The operation is
  // recoverable either way — this modal exists for undo-reduction, not
  // the "are you sure?" gate itself.

  import { preferences } from "$lib/stores/preferences.svelte";
  import { formatError } from "$lib/errors";

  type Props = {
    /** Display name shown in the prompt (filename, or folder name). */
    name: string;
    /** `true` if the target is a directory — changes the prompt copy. */
    isDirectory?: boolean;
    /** Runs the deletion. Awaited; any thrown error is rendered inline. */
    onConfirm: () => Promise<void>;
    onClose: () => void;
  };

  let { name, isDirectory = false, onConfirm, onClose }: Props = $props();

  let dontAskAgain = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function handleConfirm() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      if (dontAskAgain) {
        preferences.setSkipDeleteConfirmation(true);
      }
      await onConfirm();
      onClose();
    } catch (e) {
      error = formatError(e);
    } finally {
      busy = false;
    }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget && !busy) onClose();
  }

  function handleKey(e: KeyboardEvent) {
    if (busy) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirm();
    }
  }
</script>

<svelte:window onkeydown={handleKey} />

<div class="backdrop" onclick={handleBackdrop} role="presentation">
  <div
    class="dialog"
    role="dialog"
    aria-labelledby="delete-title"
    aria-modal="true"
  >
    <h2 id="delete-title">
      Move {isDirectory ? "folder" : "file"} to trash?
    </h2>
    <p class="desc">
      <code>{name}</code>
      {#if isDirectory}
        and everything inside it will be moved to the system trash. You can
        restore it from there.
      {:else}
        will be moved to the system trash. You can restore it from there.
      {/if}
    </p>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <label class="checkbox-row">
      <input type="checkbox" bind:checked={dontAskAgain} disabled={busy} />
      <span>Don't ask again</span>
    </label>

    <div class="actions">
      <button
        type="button"
        class="secondary"
        onclick={onClose}
        disabled={busy}
      >
        Cancel
      </button>
      <button
        type="button"
        class="primary destructive"
        onclick={handleConfirm}
        disabled={busy}
      >
        {busy ? "Moving…" : "Move to trash"}
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
    z-index: 150;
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  }

  .dialog {
    background: var(--skrive-bg);
    border: 2px solid var(--skrive-fg);
    padding: 1.5rem 1.75rem;
    width: 26rem;
    max-width: calc(100vw - 2rem);
  }

  h2 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--skrive-fg);
  }

  .desc {
    margin: 0 0 1rem;
    font-size: 0.8125rem;
    color: var(--skrive-muted);
    line-height: 1.5;
  }

  .desc code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--skrive-fg);
    background: var(--skrive-rule);
    padding: 0.05rem 0.25rem;
    border-radius: 2px;
    word-break: break-all;
  }

  .error {
    margin: 0 0 0.75rem;
    font-size: 0.75rem;
    color: #a84030;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
    font-size: 0.8125rem;
    color: var(--skrive-muted);
    cursor: pointer;
    user-select: none;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  button {
    padding: 0.5rem 1rem;
    border-radius: 4px;
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
    border: 1px solid var(--skrive-fg);
    background: transparent;
    color: var(--skrive-fg);
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
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

  button.primary.destructive {
    border-color: #a84030;
    color: #a84030;
  }

  button.primary.destructive:not(:disabled):hover {
    background: #a84030;
    color: #fff;
  }
</style>
