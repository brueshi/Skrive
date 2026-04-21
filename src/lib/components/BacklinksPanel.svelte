<script lang="ts">
  // Floating backlinks list for the active tab. "What links to this
  // file?" — one row per inbound reference, showing source path, line
  // number, and a snippet of the line it appears on. Clicking a row
  // opens that source file at the referenced line.
  //
  // The list data lives on the project store (`backlinksOfActive`) so
  // the header's BL · N indicator reads the same array without a second
  // round-trip. Refresh triggers live in +page.svelte — on tab change
  // and on watcher events — so by the time this panel renders, the
  // data is already fresh.
  //
  // Shares the top-right anchor zone with the frontmatter and personal
  // dictionary panels. Opening this one closes both of the others so
  // they never overlap visually.

  import { project } from "$lib/stores/project.svelte";
  import { preferences } from "$lib/stores/preferences.svelte";
  import { notify } from "$lib/stores/notifications.svelte";
  import { formatError } from "$lib/errors";

  let panelRoot: HTMLDivElement | undefined = $state();

  const activePath = $derived(project.activeTab?.path ?? "");
  const rows = $derived(project.backlinksOfActive);

  // Mutual exclusion with the other two floating panels that share this
  // anchor zone. One-way — matches the existing frontmatter ↔ dictionary
  // pattern where the last panel opened wins.
  $effect(() => {
    if (project.backlinksPanelOpen) {
      if (project.frontmatterPanelOpen) project.closeFrontmatterPanel();
      if (preferences.dictionaryPanelOpen) preferences.closeDictionaryPanel();
    }
  });

  async function handleRowClick(path: string, line: number, column: number) {
    // Close the panel first so the editor gets focus cleanly — otherwise
    // the click-outside handler races the tab switch.
    project.closeBacklinksPanel();
    try {
      // `line` is 1-indexed; column is a 0-indexed UTF-16 offset.
      // `openTabAtLine` takes exactly that shape.
      await project.openTabAtLine(path, line, column, 0);
    } catch (err) {
      notify.error(
        `Couldn't open ${path} at line ${line}: ${formatError(err)}`,
        err,
      );
    }
  }

  function handleRowKeydown(
    e: KeyboardEvent,
    path: string,
    line: number,
    column: number,
  ) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void handleRowClick(path, line, column);
    }
  }

  function handleRootKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      project.closeBacklinksPanel();
    }
  }

  // Click-outside dismissal. Mirrors the other two panels' pattern.
  $effect(() => {
    if (!project.backlinksPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (!panelRoot) return;
      const target = e.target as Node | null;
      if (target && !panelRoot.contains(target)) {
        // Ignore clicks on the BL indicator itself — its own click
        // handler toggles the panel and we don't want both to fire.
        const hit = (target as Element | null)?.closest?.(".bl-indicator");
        if (hit) return;
        project.closeBacklinksPanel();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  });
</script>

<div
  class="bl-panel-wrapper"
  class:bl-panel-open={project.backlinksPanelOpen}
  aria-hidden={!project.backlinksPanelOpen}
>
  <div
    class="bl-panel"
    bind:this={panelRoot}
    role="dialog"
    tabindex="-1"
    aria-label="Backlinks"
    onkeydown={handleRootKeydown}
  >
    <header class="bl-panel-header">
      <span class="bl-panel-title">Backlinks</span>
      <span class="bl-panel-target" title={activePath}>{activePath}</span>
      <span class="bl-panel-count">{rows.length}</span>
    </header>

    <div class="bl-panel-body">
      {#if rows.length === 0}
        <p class="bl-empty">Nothing links to this file yet.</p>
      {:else}
        <ul class="bl-rows">
          {#each rows as row (row.path + ":" + row.line + ":" + row.column)}
            <li class="bl-row">
              <button
                type="button"
                class="bl-row-button"
                onclick={() => handleRowClick(row.path, row.line, row.column)}
                onkeydown={(e) =>
                  handleRowKeydown(e, row.path, row.line, row.column)}
                title={`${row.path}:${row.line}`}
              >
                <span class="bl-row-meta">
                  <span class="bl-row-path">{row.path}</span>
                  <span class="bl-row-line">:{row.line}</span>
                </span>
                <span class="bl-row-snippet">{row.snippet}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</div>

<style>
  .bl-panel-wrapper {
    position: absolute;
    top: 48px;
    right: 12px;
    width: 26rem;
    max-width: calc(100vw - 24px);
    z-index: 100;

    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 180ms cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: none;
  }

  .bl-panel-wrapper.bl-panel-open {
    grid-template-rows: 1fr;
    pointer-events: auto;
  }

  .bl-panel {
    overflow: hidden;
    background: var(--skrive-bg);
    border: 1px solid var(--skrive-fg);
    border-radius: 4px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
    opacity: 0;
    transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
    max-height: 50vh;
    display: flex;
    flex-direction: column;
  }

  .bl-panel-wrapper.bl-panel-open .bl-panel {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .bl-panel-wrapper,
    .bl-panel {
      transition: none;
    }
  }

  .bl-panel-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--skrive-rule);
    flex-shrink: 0;
    background: var(--skrive-bg);
  }

  .bl-panel-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    color: var(--skrive-fg);
    flex-shrink: 0;
  }

  .bl-panel-target {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .bl-panel-count {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    flex-shrink: 0;
  }

  .bl-panel-body {
    padding: 0.25rem 0;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    font-size: 13px;
  }

  .bl-empty {
    margin: 0;
    padding: 0.5rem 0.875rem 0.75rem;
    font-size: 12px;
    color: var(--skrive-muted);
    line-height: 1.5;
  }

  .bl-rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .bl-row + .bl-row {
    border-top: 1px dashed var(--skrive-rule);
  }

  .bl-row-button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    background: transparent;
    border: none;
    padding: 0.45rem 0.875rem;
    font: inherit;
    color: var(--skrive-fg);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .bl-row-button:hover,
  .bl-row-button:focus-visible {
    background: var(--skrive-rule);
    outline: none;
  }

  .bl-row-meta {
    display: inline-flex;
    align-items: baseline;
    gap: 0.15rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }

  .bl-row-path {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bl-row-line {
    flex-shrink: 0;
    opacity: 0.8;
  }

  .bl-row-snippet {
    font-size: 12px;
    color: var(--skrive-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
    line-height: 1.4;
  }
</style>
