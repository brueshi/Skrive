<script lang="ts">
  // Reusable floating context menu.
  //
  // The menu is positioned at an anchor point (usually the mouse coords of a
  // right-click), closed by Escape, click-outside, or any item activation.
  // Arrow-key navigation + Enter activates — the first item is auto-focused
  // so keyboard users never need to grab the mouse.
  //
  // Visual language matches the rest of the app: borders, not shadows;
  // foreground-colored border rather than elevation trickery.

  import { onMount, tick } from "svelte";

  export type ContextMenuItem = {
    label: string;
    onClick: () => void;
    /** Shown right-aligned as a keyboard hint. */
    shortcut?: string;
    /** `destructive` paints the label in the error color. */
    variant?: "default" | "destructive";
    disabled?: boolean;
  };

  type Props = {
    x: number;
    y: number;
    items: ContextMenuItem[];
    onDismiss: () => void;
  };

  let { x, y, items, onDismiss }: Props = $props();

  let menuEl: HTMLDivElement | null = $state(null);
  let focusedIndex = $state(0);

  // Clamp the anchor so the menu never renders off-screen. Measured after
  // mount because we need the menu's actual size. The initial 0,0 is a
  // one-frame flash we hide by not committing to coords until post-mount;
  // the overlay is dim enough that it reads as a fade-in.
  let left = $state(0);
  let top = $state(0);
  let positioned = $state(false);

  onMount(async () => {
    await tick();
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const margin = 8;
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;
    left = Math.max(margin, Math.min(x, maxLeft));
    top = Math.max(margin, Math.min(y, maxTop));
    positioned = true;
    // Focus the first non-disabled item so keyboard nav starts there.
    const firstEnabled = items.findIndex((i) => !i.disabled);
    if (firstEnabled !== -1) {
      focusedIndex = firstEnabled;
      const buttons = menuEl.querySelectorAll<HTMLButtonElement>("button");
      buttons[firstEnabled]?.focus();
    }
  });

  function activate(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    onDismiss();
    // Run after dismiss so any UI the item opens sees the menu already gone.
    queueMicrotask(() => item.onClick());
  }

  function moveFocus(delta: number) {
    if (items.length === 0) return;
    let next = focusedIndex;
    for (let i = 0; i < items.length; i++) {
      next = (next + delta + items.length) % items.length;
      if (!items[next]?.disabled) break;
    }
    focusedIndex = next;
    const buttons = menuEl?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[next]?.focus();
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activate(focusedIndex);
    }
  }

  function handleBackdrop(e: MouseEvent) {
    // Any click that isn't on a menu item dismisses. The backdrop is
    // transparent and fills the viewport so the menu reads as floating
    // without reserving a pointer-event layer on the page behind it.
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onDismiss();
    }
  }
</script>

<svelte:window onkeydown={handleKey} />

<div
  class="backdrop"
  onmousedown={handleBackdrop}
  oncontextmenu={handleBackdrop}
  role="presentation"
>
  <div
    bind:this={menuEl}
    class="menu"
    role="menu"
    style:left="{left}px"
    style:top="{top}px"
    style:visibility={positioned ? "visible" : "hidden"}
  >
    {#each items as item, i (i)}
      <button
        type="button"
        role="menuitem"
        class="item"
        class:destructive={item.variant === "destructive"}
        disabled={item.disabled}
        onclick={() => activate(i)}
        onmouseenter={() => {
          focusedIndex = i;
        }}
      >
        <span class="label">{item.label}</span>
        {#if item.shortcut}
          <span class="shortcut">{item.shortcut}</span>
        {/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
  }

  .menu {
    position: fixed;
    min-width: 10rem;
    background: var(--skrive-bg);
    border: 1px solid var(--skrive-fg);
    padding: 0.25rem 0;
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    font-size: 13px;
    color: var(--skrive-fg);
  }

  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    width: 100%;
    padding: 0.375rem 0.75rem;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .item:focus {
    outline: none;
    background: var(--skrive-rule);
  }

  .item:hover:not(:disabled) {
    background: var(--skrive-rule);
  }

  .item:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .item.destructive {
    color: #a84030;
  }

  .shortcut {
    color: var(--skrive-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
  }
</style>
