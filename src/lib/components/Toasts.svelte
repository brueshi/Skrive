<script lang="ts">
  // Bottom-right toast stack. One component mounted at the workspace root;
  // every push to `notify.*` appears here with a short auto-dismiss and a
  // manual × to banish it sooner.
  //
  // Visual treatment mirrors the rest of the chrome — borders, not shadows;
  // monospace for the error variant so errors read as console-ish.

  import {
    notify,
    type Notification,
    type NotificationAction,
  } from "$lib/stores/notifications.svelte";
  import IconX from "$lib/icons/IconX.svelte";

  function label(n: Notification): string {
    switch (n.variant) {
      case "error":
        return "Error";
      case "success":
        return "Done";
      default:
        return "Info";
    }
  }

  // Wrap action clicks: run the callback, then dismiss the toast.
  // Keeps every caller from having to remember to dismiss manually.
  async function handleAction(id: number, action: NotificationAction) {
    try {
      await action.onClick();
    } finally {
      notify.dismiss(id);
    }
  }
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each notify.list as n (n.id)}
    <div class="toast toast-{n.variant}">
      <span class="toast-label">{label(n)}</span>
      <span class="toast-message">{n.message}</span>
      {#if n.action}
        <button
          type="button"
          class="toast-action"
          onclick={() => void handleAction(n.id, n.action!)}
        >
          {n.action.label}
        </button>
      {/if}
      <button
        type="button"
        class="toast-dismiss"
        aria-label="Dismiss"
        onclick={() => notify.dismiss(n.id)}
      >
        <IconX size={16} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.5rem;
    z-index: 250;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: inline-flex;
    align-items: flex-start;
    gap: 0.6rem;
    max-width: 24rem;
    padding: 0.5rem 0.5rem 0.5rem 0.75rem;
    background: var(--skrive-bg);
    border: 1px solid var(--skrive-fg);
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    font-size: 0.8125rem;
    color: var(--skrive-fg);
    animation: toast-in 160ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }

  .toast-label {
    flex-shrink: 0;
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--skrive-muted);
    padding-top: 0.15rem;
  }

  .toast-error {
    border-color: #a84030;
  }

  .toast-error .toast-label {
    color: #a84030;
  }

  .toast-error .toast-message {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
  }

  .toast-success {
    border-color: var(--skrive-fg);
  }

  .toast-message {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    line-height: 1.4;
  }

  .toast-action {
    flex-shrink: 0;
    align-self: center;
    background: transparent;
    border: 1px solid var(--skrive-fg);
    color: var(--skrive-fg);
    font: inherit;
    font-size: 0.75rem;
    padding: 0.25rem 0.625rem;
    border-radius: 3px;
    cursor: pointer;
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .toast-action:hover {
    background: var(--skrive-fg);
    color: var(--skrive-bg);
  }

  .toast-dismiss {
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    cursor: pointer;
    padding: 2px;
    margin: -2px -2px 0 0;
    border-radius: 2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .toast-dismiss:hover {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }
</style>
