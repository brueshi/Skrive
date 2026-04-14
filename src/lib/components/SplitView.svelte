<script lang="ts">
  // The three-mode editor surface: raw / split / preview.
  //
  // In raw mode the editor fills the pane. In preview mode the rendered
  // output fills the pane. In split mode the pane is divided by a draggable
  // 1px rule; the ratio lives on the active tab in the project store so
  // flipping between files restores each file's own divider position.
  //
  // Drag handling:
  //   - We own no local "current ratio" state. Pointer moves write straight
  //     into the store via `setSplitDividerRatio`, which clamps and persists.
  //   - Pointer capture is on the divider element; we do NOT listen on window
  //     so nested iframes and picker overlays cannot swallow the drag.
  //   - We freeze the container bounding rect at pointerdown. Measuring on
  //     every move is correct but wasteful, and the pane can't resize during
  //     a drag anyway — the user is busy dragging.

  import Editor from "$lib/editor/Editor.svelte";
  import Preview from "$lib/preview/Preview.svelte";
  import { project } from "$lib/stores/project.svelte";
  import type { LayoutMode } from "$lib/types";

  type Props = {
    mode: LayoutMode;
    ratio: number;
    body: string;
    onChange: (next: string) => void;
  };

  let { mode, ratio, body, onChange }: Props = $props();

  let container: HTMLDivElement;
  let dragging = $state(false);

  let dragBounds: { left: number; width: number } | null = null;

  function handlePointerDown(e: PointerEvent) {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    dragBounds = { left: rect.left, width: rect.width };
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handlePointerMove(e: PointerEvent) {
    if (!dragging || !dragBounds) return;
    const offset = e.clientX - dragBounds.left;
    const next = offset / dragBounds.width;
    project.setSplitDividerRatio(next);
  }

  function handlePointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    dragBounds = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  let editorFlex = $derived(ratio);
  let previewFlex = $derived(1 - ratio);
</script>

<div
  class="split-view"
  class:mode-raw={mode === "raw"}
  class:mode-split={mode === "split"}
  class:mode-preview={mode === "preview"}
  class:dragging
  bind:this={container}
>
  {#if mode !== "preview"}
    <div
      class="pane editor-pane"
      style:flex-grow={mode === "split" ? editorFlex : 1}
    >
      <Editor value={body} {onChange} />
    </div>
  {/if}

  {#if mode === "split"}
    <div
      class="divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize editor and preview"
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerUp}
    ></div>
  {/if}

  {#if mode !== "raw"}
    <div
      class="pane preview-pane"
      style:flex-grow={mode === "split" ? previewFlex : 1}
    >
      <Preview {body} />
    </div>
  {/if}
</div>

<style>
  .split-view {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .pane {
    flex-basis: 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .editor-pane {
    background: var(--skrive-bg);
  }

  .preview-pane {
    background: var(--skrive-bg);
  }

  .divider {
    flex: 0 0 1px;
    width: 1px;
    cursor: col-resize;
    background: var(--skrive-rule);
    position: relative;
    touch-action: none;
  }

  /* Fatten the hit area without shifting layout. The visible rule stays 1px
     wide; the pseudo-element catches the pointer in a 9px gutter centered on
     the rule so the user can grab it without pixel-hunting. */
  .divider::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -4px;
    right: -4px;
  }

  .divider:hover,
  .split-view.dragging .divider {
    background: var(--skrive-fg);
  }

  .split-view.dragging {
    /* Prevent text selection flicker during a drag. */
    user-select: none;
  }
</style>
