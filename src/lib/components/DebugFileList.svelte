<script lang="ts">
  // Temporary sidebar that lists every Markdown file in the project and every
  // currently open tab. This is intentionally rough — Step 2 replaces it with
  // the real sidebar (hideable, styled, with icons) and a separate tab bar
  // above the editor. For Step 1, this is our only way to navigate.

  import { project } from "$lib/stores/project.svelte";

  async function handleOpenFile(path: string) {
    try {
      await project.openTab(path);
    } catch (e) {
      console.error("Failed to open file:", path, e);
    }
  }

  function handleCloseTab(index: number) {
    project.closeTab(index);
  }
</script>

<aside class="debug-file-list">
  <header>
    <span class="title">Files</span>
    <span class="count">{project.manifest?.files.length ?? 0}</span>
  </header>
  <ul class="files">
    {#each project.manifest?.files ?? [] as file (file.path)}
      <li>
        <button
          type="button"
          class="file"
          class:active={project.activeTab?.path === file.path}
          onclick={() => handleOpenFile(file.path)}
        >
          {file.path}
        </button>
      </li>
    {/each}
  </ul>

  {#if project.tabs.length > 0}
    <header class="section-header">
      <span class="title">Open tabs</span>
      <span class="count">{project.tabs.length}</span>
    </header>
    <ul class="tabs">
      {#each project.tabs as tab, i (tab.path)}
        <li class="tab-row" class:active={i === project.activeTabIndex}>
          <button
            type="button"
            class="tab-open"
            onclick={() => project.switchTab(i)}
          >
            <span class="name">{tab.path}</span>
            {#if tab.dirty}
              <span class="dirty" aria-label="unsaved changes">●</span>
            {/if}
          </button>
          <button
            type="button"
            class="tab-close"
            aria-label="Close tab"
            onclick={() => handleCloseTab(i)}
          >
            ×
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .debug-file-list {
    width: 260px;
    flex-shrink: 0;
    border-right: 1px solid var(--skrive-rule);
    overflow-y: auto;
    background: var(--skrive-bg);
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    font-size: 13px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--skrive-rule);
  }

  .section-header {
    border-top: 1px solid var(--skrive-rule);
  }

  .title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--skrive-muted);
  }

  .count {
    font-size: 11px;
    color: var(--skrive-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .file {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    padding: 0.5rem 1rem;
    font: inherit;
    color: var(--skrive-fg);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file:hover {
    background: var(--skrive-rule);
  }

  .file.active {
    background: var(--skrive-rule);
    border-left-color: var(--skrive-fg);
  }

  .tab-row {
    display: flex;
    align-items: stretch;
    border-left: 2px solid transparent;
  }

  .tab-row:hover {
    background: var(--skrive-rule);
  }

  .tab-row.active {
    background: var(--skrive-rule);
    border-left-color: var(--skrive-fg);
  }

  .tab-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-align: left;
    background: transparent;
    border: none;
    padding: 0.5rem 0.25rem 0.5rem 1rem;
    font: inherit;
    color: var(--skrive-fg);
    cursor: pointer;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dirty {
    color: var(--skrive-fg);
    font-size: 10px;
    line-height: 1;
  }

  .tab-close {
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 0.75rem;
    opacity: 0;
    transition: opacity 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .tab-row:hover .tab-close,
  .tab-row.active .tab-close {
    opacity: 1;
  }

  .tab-close:hover {
    color: var(--skrive-fg);
  }
</style>
