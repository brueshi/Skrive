<script lang="ts">
  // Top bar of the workspace. Shows the project name, the tab bar, the
  // layout-mode toggle, and the sidebar toggle.
  //
  // The tab bar lives here rather than above the editor because the design
  // target is editorial: the chrome should not compete with the writing
  // surface, so every piece of chrome stays pinned at the top edge and the
  // editor owns the entire lower region.

  import { project } from "$lib/stores/project.svelte";
  import type { LayoutMode } from "$lib/types";
  import IconLayoutRaw from "$lib/icons/IconLayoutRaw.svelte";
  import IconLayoutSplit from "$lib/icons/IconLayoutSplit.svelte";
  import IconLayoutPreview from "$lib/icons/IconLayoutPreview.svelte";
  import IconSidebarToggle from "$lib/icons/IconSidebarToggle.svelte";
  import IconDotUnsaved from "$lib/icons/IconDotUnsaved.svelte";
  import IconX from "$lib/icons/IconX.svelte";

  let projectName = $derived.by(() => {
    const root = project.manifest?.root;
    if (!root) return "";
    const parts = root.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? root;
  });

  // Field count for the FM · N indicator. Reads directly from the active
  // tab's frontmatter map so it updates reactively as the user adds or
  // removes fields through the panel.
  let frontmatterFieldCount = $derived.by(() => {
    const fm = project.activeTab?.content.frontmatter;
    if (!fm) return 0;
    return Object.keys(fm).length;
  });

  function setMode(mode: LayoutMode) {
    project.setLayoutMode(mode);
  }

  function isMode(mode: LayoutMode): boolean {
    return project.activeTab?.layoutMode === mode;
  }

  function handleCloseTab(e: Event, index: number) {
    e.stopPropagation();
    project.closeTab(index);
  }
</script>

<header class="header">
  <div class="left">
    <button
      type="button"
      class="icon-button sidebar-toggle"
      aria-label={project.sidebarVisible ? "Hide sidebar" : "Show sidebar"}
      aria-pressed={project.sidebarVisible}
      title="Toggle sidebar  ⌘B"
      onclick={() => project.toggleSidebar()}
    >
      <IconSidebarToggle size={16} shown={project.sidebarVisible} />
    </button>
    <span class="brand">Skrive</span>
    <span class="project-name" title={project.manifest?.root ?? ""}
      >{projectName}</span
    >
  </div>

  <div class="tabs" role="tablist">
    {#each project.tabs as tab, i (tab.path)}
      <button
        type="button"
        role="tab"
        class="tab"
        class:active={i === project.activeTabIndex}
        aria-selected={i === project.activeTabIndex}
        onclick={() => project.switchTab(i)}
        title={tab.path}
      >
        <span class="tab-name">{tab.path.split("/").pop()}</span>
        {#if tab.dirty}
          <span class="tab-dirty" aria-label="unsaved changes">
            <IconDotUnsaved size={16} />
          </span>
        {/if}
        <span
          class="tab-close"
          role="button"
          tabindex="-1"
          aria-label="Close tab"
          onclick={(e) => handleCloseTab(e, i)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") handleCloseTab(e, i);
          }}
        >
          <IconX size={16} />
        </span>
      </button>
    {/each}
  </div>

  <div class="right">
    {#if project.activeTab}
      <button
        type="button"
        class="fm-indicator"
        class:fm-indicator-empty={frontmatterFieldCount === 0}
        class:fm-indicator-active={project.frontmatterPanelOpen}
        aria-label={project.frontmatterPanelOpen
          ? "Close frontmatter panel"
          : "Open frontmatter panel"}
        aria-pressed={project.frontmatterPanelOpen}
        title="Frontmatter  ⌘⇧F"
        onclick={() => project.toggleFrontmatterPanel()}
      >
        <span class="fm-label">FM</span>
        <span class="fm-sep">·</span>
        <span class="fm-count"
          >{frontmatterFieldCount === 0 ? "+" : frontmatterFieldCount}</span
        >
      </button>
      <div class="mode-toggle" role="group" aria-label="Layout mode">
        <button
          type="button"
          class="mode-button"
          class:active={isMode("raw")}
          aria-pressed={isMode("raw")}
          title="Raw  ⌘1"
          onclick={() => setMode("raw")}
        >
          <IconLayoutRaw size={16} />
        </button>
        <button
          type="button"
          class="mode-button"
          class:active={isMode("split")}
          aria-pressed={isMode("split")}
          title="Split  ⌘2"
          onclick={() => setMode("split")}
        >
          <IconLayoutSplit size={16} />
        </button>
        <button
          type="button"
          class="mode-button"
          class:active={isMode("preview")}
          aria-pressed={isMode("preview")}
          title="Preview  ⌘3"
          onclick={() => setMode("preview")}
        >
          <IconLayoutPreview size={16} />
        </button>
      </div>
    {/if}
  </div>
</header>

<style>
  .header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--skrive-rule);
    flex-shrink: 0;
    background: var(--skrive-bg);
    height: 40px;
    box-sizing: border-box;
  }

  .left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    min-width: 0;
  }

  .brand {
    font-weight: 600;
    font-size: 0.8125rem;
    letter-spacing: -0.01em;
    color: var(--skrive-fg);
  }

  .project-name {
    font-size: 0.6875rem;
    color: var(--skrive-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 14rem;
  }

  .tabs {
    flex: 1;
    display: flex;
    gap: 0.25rem;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.375rem 0.25rem 0.625rem;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--skrive-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    max-width: 14rem;
    flex-shrink: 0;
  }

  .tab:hover {
    background: var(--skrive-rule);
    color: var(--skrive-fg);
  }

  .tab.active {
    background: var(--skrive-rule);
    color: var(--skrive-fg);
  }

  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 10rem;
  }

  .tab-dirty {
    display: inline-flex;
    color: var(--skrive-fg);
    /* The IconDotUnsaved pip wants the cream background behind the brass;
       leaving it at full color when the tab isn't active would fight the
       muted-text rule. Full color is fine because the icon itself is quiet. */
  }

  .tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.12s cubic-bezier(0.4, 0, 0.2, 1);
    border-radius: 2px;
    padding: 2px;
    color: var(--skrive-muted);
    cursor: pointer;
  }

  .tab:hover .tab-close,
  .tab.active .tab-close {
    opacity: 1;
  }

  .tab-close:hover {
    color: var(--skrive-fg);
    background: var(--skrive-bg);
  }

  .right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .icon-button {
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    cursor: pointer;
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    padding: 0;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .icon-button:hover {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  .mode-toggle {
    display: inline-flex;
    border: 1px solid var(--skrive-rule);
    border-radius: 4px;
    overflow: hidden;
  }

  .mode-button {
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    cursor: pointer;
    width: 28px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .mode-button + .mode-button {
    border-left: 1px solid var(--skrive-rule);
  }

  .mode-button:hover {
    color: var(--skrive-fg);
  }

  .mode-button.active {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  /* Frontmatter panel indicator. Lives to the left of the layout mode
     toggle and acts as both an "N fields on this file" glance and the
     click target for opening the panel. Monospace to match the project-
     name style so it reads as metadata, not a primary action. */
  .fm-indicator {
    display: inline-flex;
    align-items: center;
    gap: 0.3em;
    background: transparent;
    border: 1px solid var(--skrive-rule);
    border-radius: 4px;
    height: 24px;
    padding: 0 0.5rem;
    color: var(--skrive-muted);
    cursor: pointer;
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 0.02em;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .fm-indicator:hover {
    color: var(--skrive-fg);
    border-color: var(--skrive-fg);
  }

  .fm-indicator.fm-indicator-active {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
    border-color: var(--skrive-fg);
  }

  /* Subtle de-emphasis when the active file has no frontmatter yet —
     the `FM · +` state is still clickable and discoverable, just quieter
     than a populated file would be. */
  .fm-indicator.fm-indicator-empty .fm-count {
    opacity: 0.7;
  }

  .fm-label {
    font-weight: 600;
  }

  .fm-sep {
    opacity: 0.5;
  }
</style>
