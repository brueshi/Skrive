<script lang="ts">
  // Top bar of the workspace. Shows the project name, the tab bar, the
  // layout-mode toggle, and the sidebar toggle.
  //
  // The tab bar lives here rather than above the editor because the design
  // target is editorial: the chrome should not compete with the writing
  // surface, so every piece of chrome stays pinned at the top edge and the
  // editor owns the entire lower region.

  import { project } from "$lib/stores/project.svelte";
  import { preferences } from "$lib/stores/preferences.svelte";
  import type { LayoutMode } from "$lib/types";
  import IconLayoutRaw from "$lib/icons/IconLayoutRaw.svelte";
  import IconLayoutSplit from "$lib/icons/IconLayoutSplit.svelte";
  import IconLayoutPreview from "$lib/icons/IconLayoutPreview.svelte";
  import IconSidebarToggle from "$lib/icons/IconSidebarToggle.svelte";
  import IconDotUnsaved from "$lib/icons/IconDotUnsaved.svelte";
  import IconDocMarkdown from "$lib/icons/IconDocMarkdown.svelte";
  import IconFrontmatter from "$lib/icons/IconFrontmatter.svelte";
  import IconBacklinks from "$lib/icons/IconBacklinks.svelte";
  import IconDictionary from "$lib/icons/IconDictionary.svelte";
  import IconHistory from "$lib/icons/IconHistory.svelte";
  import IconX from "$lib/icons/IconX.svelte";
  import ContextMenu, {
    type ContextMenuItem,
  } from "$lib/components/ContextMenu.svelte";
  import {
    openProjectFromPicker,
    closeCurrentProject,
    openRecentProject,
  } from "$lib/project-actions";
  import { checkForUpdatesManual } from "$lib/updater";

  type Props = {
    // +page.svelte owns the autosave hooks; we pass them through so the
    // close-project flush uses the same error-surfacing path as
    // everything else.
    autoSaveHooks: {
      onSaved: (path: string) => void;
      onError: (path: string, err: unknown) => void;
    };
  };

  let { autoSaveHooks }: Props = $props();

  // The window uses macOS overlay title bar (tauri.conf.json), so traffic
  // lights float over our chrome. Pad the header on macOS only — Windows /
  // Linux have native chrome above the app and don't need the offset.
  const isMacOS =
    typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

  let projectName = $derived.by(() => {
    const root = project.manifest?.root;
    if (!root) return "";
    const parts = root.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? root;
  });

  function setMode(mode: LayoutMode) {
    project.setLayoutMode(mode);
  }

  // Which of the three editor buttons (raw / split / preview) is
  // highlighted. In normal mode this tracks the tab's layoutMode; in
  // diff mode we highlight `raw` for `diff-raw` and `preview` for
  // `diff-preview` so the same button that owns a representation in
  // the editor also owns it inside the diff. Split is never
  // highlighted in diff mode because it's disabled there.
  function isMode(mode: LayoutMode): boolean {
    const current = project.activeTab?.layoutMode;
    if (!current) return false;
    if (current === "diff-raw") return mode === "raw";
    if (current === "diff-preview") return mode === "preview";
    return current === mode;
  }

  // Split is disabled while any diff mode is active — the two-pane
  // surface is already in use. Tooltip explains why.
  const inDiffMode = $derived(
    project.activeTab?.layoutMode === "diff-raw" ||
      project.activeTab?.layoutMode === "diff-preview",
  );

  function handleCloseTab(e: Event, index: number) {
    e.stopPropagation();
    project.closeTab(index);
  }

  // Project menu: anchored below the project-name button. Shows Open /
  // Close plus up to a handful of recent-project entries. We deliberately
  // skip separators (the ContextMenu component doesn't support them) and
  // let the label shape carry the grouping.
  let projectMenuEl: HTMLButtonElement | null = $state(null);
  let projectMenu = $state<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  function openProjectMenu() {
    if (!projectMenuEl) return;
    const rect = projectMenuEl.getBoundingClientRect();
    const items: ContextMenuItem[] = [
      {
        label: "Open project…",
        shortcut: "⌘O",
        onClick: () => void openProjectFromPicker(),
      },
      {
        label: "Close project",
        shortcut: "⌘⇧W",
        onClick: () => void closeCurrentProject(autoSaveHooks),
      },
      {
        label: "Settings…",
        shortcut: "⌘,",
        onClick: () => project.openSettings(),
      },
      {
        label: "Command palette…",
        shortcut: "⌘⇧P",
        onClick: () => {
          // Dispatch a window-level event so +page.svelte's
          // shortcut handler can reuse the same open path it
          // uses for the keybinding.
          window.dispatchEvent(new CustomEvent("skrive:open-command-palette"));
        },
      },
      {
        label: "Check for updates…",
        onClick: () => void checkForUpdatesManual(),
      },
    ];
    const recent = preferences.recentProjects
      .filter((r) => r.path !== project.manifest?.root)
      .slice(0, 5);
    for (const r of recent) {
      items.push({
        label: r.name,
        onClick: () => void openRecentProject(r.path),
      });
    }
    projectMenu = { x: rect.left, y: rect.bottom + 4, items };
  }
</script>

<header class="header" class:is-macos={isMacOS} data-tauri-drag-region>
  <div class="left">
    <button
      type="button"
      class="icon-button sidebar-toggle"
      aria-label={project.sidebarVisible ? "Hide sidebar" : "Show sidebar"}
      aria-pressed={project.sidebarVisible}
      title="Toggle sidebar  ⌘["
      onclick={() => project.toggleSidebar()}
    >
      <IconSidebarToggle size={16} shown={project.sidebarVisible} />
    </button>
    <button
      bind:this={projectMenuEl}
      type="button"
      class="project-name"
      title={project.manifest?.root ?? ""}
      aria-haspopup="menu"
      aria-expanded={projectMenu !== null}
      onclick={openProjectMenu}
    >
      <span class="project-name-text">{projectName}</span>
      <span class="project-name-caret" aria-hidden="true">▾</span>
    </button>
  </div>

  <div class="tabs" role="tablist">
    {#each project.tabs as tab, i (tab.path)}
      <button
        type="button"
        role="tab"
        class="tab"
        class:active={i === project.activeTabIndex &&
          project.activeView === "file"}
        aria-selected={i === project.activeTabIndex &&
          project.activeView === "file"}
        onclick={() => project.switchTab(i)}
        title={tab.path}
      >
        <span class="tab-icon" aria-hidden="true">
          <IconDocMarkdown size={16} />
        </span>
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
    {#if project.settingsOpen}
      <button
        type="button"
        role="tab"
        class="tab settings-tab"
        class:active={project.activeView === "settings"}
        aria-selected={project.activeView === "settings"}
        onclick={() => project.openSettings()}
        title="Settings"
      >
        <span class="tab-name">Settings</span>
        <span
          class="tab-close"
          role="button"
          tabindex="-1"
          aria-label="Close Settings"
          onclick={(e) => {
            e.stopPropagation();
            project.closeSettings();
          }}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              project.closeSettings();
            }
          }}
        >
          <IconX size={16} />
        </span>
      </button>
    {/if}
  </div>

  <div class="right">
    {#if project.activeTab && project.activeView === "file"}
      <div class="panel-toggles" role="group" aria-label="Side panels">
        <button
          type="button"
          class="icon-button"
          class:active={project.frontmatterPanelOpen}
          data-panel-toggle="frontmatter"
          aria-label={project.frontmatterPanelOpen
            ? "Close frontmatter panel"
            : "Open frontmatter panel"}
          aria-pressed={project.frontmatterPanelOpen}
          title="Frontmatter  ⌘⇧F"
          onclick={() => project.toggleFrontmatterPanel()}
        >
          <IconFrontmatter size={16} />
        </button>
        <button
          type="button"
          class="icon-button"
          class:active={project.backlinksPanelOpen}
          data-panel-toggle="backlinks"
          aria-label={project.backlinksPanelOpen
            ? "Close backlinks panel"
            : "Open backlinks panel"}
          aria-pressed={project.backlinksPanelOpen}
          title="Backlinks  ⌘⇧B"
          onclick={() => project.toggleBacklinksPanel()}
        >
          <IconBacklinks size={16} />
        </button>
        <button
          type="button"
          class="icon-button"
          class:active={preferences.dictionaryPanelOpen}
          data-panel-toggle="dictionary"
          aria-label={preferences.dictionaryPanelOpen
            ? "Close personal dictionary"
            : "Open personal dictionary"}
          aria-pressed={preferences.dictionaryPanelOpen}
          title="Personal dictionary  ⌘⇧D"
          onclick={() => preferences.toggleDictionaryPanel()}
        >
          <IconDictionary size={16} />
        </button>
        <button
          type="button"
          class="icon-button"
          class:active={project.historyPanelOpen}
          data-panel-toggle="history"
          aria-label={project.historyPanelOpen
            ? "Close history panel"
            : "Open history panel"}
          aria-pressed={project.historyPanelOpen}
          title={`History  ⌘⇧H${project.historyMode ? `  (${project.historyMode})` : ""}`}
          onclick={() => project.toggleHistoryPanel()}
        >
          <IconHistory size={16} />
        </button>
      </div>
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
          class:disabled={inDiffMode}
          aria-pressed={isMode("split")}
          aria-disabled={inDiffMode}
          title={inDiffMode
            ? "Exit diff to split — the two-pane surface is in use"
            : "Split  ⌘2"}
          onclick={() => {
            if (inDiffMode) return;
            setMode("split");
          }}
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

{#if projectMenu}
  <ContextMenu
    x={projectMenu.x}
    y={projectMenu.y}
    items={projectMenu.items}
    onDismiss={() => {
      projectMenu = null;
    }}
  />
{/if}

<style>
  .header {
    display: flex;
    align-items: stretch;
    gap: 0.75rem;
    padding: 0 0.75rem;
    flex-shrink: 0;
    background: var(--skrive-chrome);
    height: 40px;
    box-sizing: border-box;
  }

  /* Clear the macOS traffic-light cluster (~78px wide). The chrome
     extends up under it via titleBarStyle: "Overlay", so the lights
     sit on the same surface as the rest of the chrome. */
  .header.is-macos {
    padding-left: 78px;
  }

  .left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    min-width: 0;
  }

  .project-name {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: transparent;
    border: none;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    font: inherit;
    font-size: 0.6875rem;
    color: var(--skrive-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap;
    overflow: hidden;
    max-width: 14rem;
    cursor: pointer;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .project-name:hover,
  .project-name[aria-expanded="true"] {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  .project-name-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .project-name-caret {
    font-size: 0.625rem;
    opacity: 0.6;
  }

  /* Tab strip hugs the bottom edge of the chrome row so the active
     tab can extend down to the editor edge and visually merge with it
     (Notion / browser pattern: chrome is the "shelf", active tab is
     the lifted card). 6px top inset gives breathing room above tabs. */
  .tabs {
    flex: 1;
    display: flex;
    align-items: stretch;
    gap: 2px;
    min-width: 0;
    padding-top: 6px;
    overflow: hidden;
  }

  /* Browser-style sizing — tabs hug their natural content width
     (icon + name + close), can shrink down to a 36px floor
     (icon-only) when crowded, and cap at 14rem so a 60-char filename
     can't dominate the row. flex-grow 0 means short names stay short
     instead of stretching to fill empty space. */
  .tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.5rem 0 0.625rem;
    background: transparent;
    border: none;
    border-radius: 4px 4px 0 0;
    color: var(--skrive-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    flex: 0 1 auto;
    min-width: 36px;
    max-width: 14rem;
    overflow: hidden;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .tab:hover {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  /* Active tab matches the editor cream, has only top corners
     rounded, and extends to the bottom edge of the chrome row — its
     bottom edge is the editor edge, so the two cream surfaces meet
     without a seam. Reads as "the open document". */
  .tab.active {
    color: var(--skrive-fg);
    background: var(--skrive-bg);
  }

  .tab-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--skrive-muted);
  }

  .tab.active .tab-icon,
  .tab:hover .tab-icon {
    color: var(--skrive-fg);
  }

  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
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
    background: var(--skrive-rule);
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

  .icon-button.active {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  /* Group of four side-panel toggles (frontmatter / backlinks /
     dictionary / history). Sits to the left of the layout-mode group;
     the small inner gap keeps them as a visual cluster without
     drawing a border around them. */
  .panel-toggles {
    display: inline-flex;
    align-items: center;
    gap: 1px;
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

  /* Greyed-out state for the disabled `split` button during diff mode.
     Tooltip (set in the template) explains why the button is dead. */
  .mode-button.disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .mode-button.disabled:hover {
    color: var(--skrive-muted);
  }
</style>
