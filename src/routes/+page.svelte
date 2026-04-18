<script lang="ts">
  // The workspace page. Composes the sidebar + header + split view and owns
  // the cross-cutting concerns that don't fit inside any one component:
  //   - global keyboard shortcuts (⌘B, ⌘1/2/3, ⌘S)
  //   - auto-save debouncing
  //   - watcher event handling with self-write suppression
  //   - project UI state persistence
  //   - kicking off the watcher on project open
  //
  // Everything below the chrome bar is the SplitView, which owns the
  // editor/preview layout. The sidebar is a peer of SplitView, not a child,
  // so toggling it cleanly resizes the editor without remounting.

  import { onMount, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";

  import { project } from "$lib/stores/project.svelte";
  import { preferences } from "$lib/stores/preferences.svelte";
  import type { LayoutMode } from "$lib/types";
  import { formatError } from "$lib/errors";
  import {
    scheduleSave,
    flushSave,
    isRecentSelfWrite,
  } from "$lib/persistence/autosave";
  import {
    restoreProjectState,
    queueSaveProjectState,
    resetProjectStateTarget,
  } from "$lib/persistence/projectState";

  import EmptyState from "$lib/components/EmptyState.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import Header from "$lib/components/Header.svelte";
  import SplitView from "$lib/components/SplitView.svelte";
  import FrontmatterPanel from "$lib/components/FrontmatterPanel.svelte";
  import PersonalDictionaryPanel from "$lib/components/PersonalDictionaryPanel.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";

  type WatcherPayload = {
    path: string;
    kind: "created" | "modified" | "removed";
  };

  let reloadPrompt = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  let commandPaletteOpen = $state(false);

  const autoSaveHooks = {
    onSaved: (path: string) => {
      project.markTabSaved(path);
      saveError = null;
    },
    onError: (path: string, err: unknown) => {
      console.error("Failed to save", path, err);
      saveError = formatError(err);
    },
    /**
     * Fired when the save driver pulled a leading frontmatter block out
     * of the body. We update the tab's body in place so the CodeMirror
     * view sees a new `value` prop and dispatches a replace transaction;
     * the user's view of the document shrinks by exactly the length of
     * the extracted fence. The frontmatter map was already updated by
     * reference inside the save driver.
     */
    onBodyRewritten: (path: string, newBody: string) => {
      const tab = project.tabs.find((t) => t.path === path);
      if (tab) tab.content.body = newBody;
      // Visual breadcrumb: the editor surface flashes briefly so the
      // user knows the system just rewrote the body (e.g. autosave
      // pulled a typed `---` block into the structured frontmatter
      // store and the editor shrank as a result).
      project.signalEditorPulse();
    },
  };

  function handleChange(next: string) {
    project.updateActiveTabContent(next);
    const tab = project.activeTab;
    if (!tab) return;
    scheduleSave(
      tab.path,
      { body: next, frontmatter: tab.content.frontmatter },
      autoSaveHooks,
    );
  }

  async function forceSaveActive() {
    const tab = project.activeTab;
    if (!tab) return;
    await flushSave(tab.path, autoSaveHooks);
  }

  async function acceptReload() {
    if (!reloadPrompt) return;
    const path = reloadPrompt;
    reloadPrompt = null;
    try {
      await project.reloadTab(path);
    } catch (err) {
      console.error("Failed to reload", path, err);
    }
  }

  function dismissReload() {
    reloadPrompt = null;
  }

  // ======================== Project-open side effects ========================

  // When a project opens for the first time (or switches), kick off the
  // watcher and restore persisted UI state. Tracked by project.manifest?.root
  // so changing projects triggers the effect cleanly.
  let lastWatchedRoot: string | null = null;
  $effect(() => {
    const root = project.manifest?.root ?? null;
    if (!root || root === lastWatchedRoot) return;
    lastWatchedRoot = root;

    // Restore before starting the watcher so the initial "file-changed"
    // burst some filesystems emit on mount doesn't race the restore.
    (async () => {
      try {
        await restoreProjectState(root);
      } catch (err) {
        console.warn("Failed to restore project state:", err);
      }
      try {
        await invoke("watch_project");
      } catch (err) {
        console.warn("Failed to start file watcher:", err);
      }
    })();
  });

  // Persist UI state whenever any persisted field changes. We read the
  // fields we care about so Svelte's signal tracking subscribes us; the
  // actual write is debounced inside queueSaveProjectState.
  $effect(() => {
    if (!project.hasProject) return;
    // Touch each piece of persisted state so the effect re-runs on change.
    void project.sidebarVisible;
    void project.activeTabIndex;
    void project.tabs.length;
    for (const t of project.tabs) {
      void t.path;
      void t.layoutMode;
      void t.splitDividerRatio;
    }
    untrack(() => queueSaveProjectState());
  });

  // ======================== Keyboard shortcuts ========================

  function handleKeydown(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey)) return;

    // ⌘⇧F toggles the frontmatter panel. The shift gate means plain ⌘F
    // stays available for a future find-in-file feature without collision.
    if (e.shiftKey && e.key.toLowerCase() === "f") {
      if (project.activeTab) {
        e.preventDefault();
        project.toggleFrontmatterPanel();
      }
      return;
    }

    // ⌘⇧D toggles the personal dictionary panel. App-wide tool, doesn't
    // require an active tab to be useful (you can manage your dictionary
    // even with no file open).
    if (e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      preferences.toggleDictionaryPanel();
      return;
    }

    // ⌘P opens the file switcher; only meaningful when a project is open.
    // ⌘⇧P is reserved for a future command-runner palette — left
    // deliberately unbound so hitting it today no-ops cleanly rather than
    // stealing focus for something else.
    if (!e.shiftKey && e.key.toLowerCase() === "p") {
      if (project.hasProject) {
        e.preventDefault();
        commandPaletteOpen = !commandPaletteOpen;
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case "b":
        e.preventDefault();
        project.toggleSidebar();
        return;
      case "s":
        e.preventDefault();
        void forceSaveActive();
        return;
      case "1":
        if (project.activeTab) {
          e.preventDefault();
          project.setLayoutMode("raw");
        }
        return;
      case "2":
        if (project.activeTab) {
          e.preventDefault();
          project.setLayoutMode("split");
        }
        return;
      case "3":
        if (project.activeTab) {
          e.preventDefault();
          project.setLayoutMode("preview");
        }
        return;
    }
  }

  // ======================== Watcher listener ========================

  let unlistenWatcher: UnlistenFn | null = null;
  onMount(() => {
    // Hydrate app-wide preferences (personal dictionary, recent
    // projects, etc.) from disk before the rest of the UI starts
    // reading them. Failures are non-fatal — the store keeps its
    // defaults and subsequent saves write a fresh file.
    void preferences.loadOnce();

    (async () => {
      unlistenWatcher = await listen<WatcherPayload>(
        "project://file-changed",
        (event) => {
          handleWatcherEvent(event.payload);
        },
      );
    })();

    return () => {
      unlistenWatcher?.();
      resetProjectStateTarget();
    };
  });

  function handleWatcherEvent(payload: WatcherPayload) {
    const { path, kind } = payload;

    // Step 1: suppress echoes of our own write_file calls.
    if (isRecentSelfWrite(path)) return;

    // Step 2: figure out if this file is open in any tab. If not, Phase 2.2
    // will eventually refresh the manifest and sidebar in-place; for now we
    // only react to changes that affect the active tab.
    const tab = project.tabs.find((t) => t.path === path);
    if (!tab) return;

    if (kind === "removed") {
      // The file vanished out from under us. Leave the content in memory so
      // the user can still save it back, but flag them.
      reloadPrompt = null;
      saveError = `${path} was removed from disk`;
      return;
    }

    // If the tab has no unsaved edits, we can auto-reload silently. Otherwise
    // we surface the prompt so the user decides whose version wins.
    if (!tab.dirty) {
      void project.reloadTab(path);
      return;
    }
    reloadPrompt = path;
  }

  let activeBody = $derived(project.activeTab?.content.body ?? "");
</script>

<svelte:window onkeydown={handleKeydown} />

{#if !project.hasProject}
  <EmptyState />
{:else}
  <main>
    <Header />
    <FrontmatterPanel />
    <PersonalDictionaryPanel />
    <div class="layout">
      {#if project.sidebarVisible}
        <Sidebar />
      {/if}
      <div class="workspace">
        {#if project.activeTab}
          {#key project.activeTab.path}
            <SplitView
              mode={project.activeTab.layoutMode}
              ratio={project.activeTab.splitDividerRatio}
              body={activeBody}
              onChange={handleChange}
            />
          {/key}
        {:else}
          <div class="no-tab">
            <p>Pick a file on the left to start.</p>
          </div>
        {/if}

        {#if reloadPrompt}
          <div class="banner" role="alert">
            <span class="banner-text"
              >{reloadPrompt} changed on disk.</span
            >
            <div class="banner-actions">
              <button type="button" class="banner-btn" onclick={acceptReload}
                >Reload</button
              >
              <button
                type="button"
                class="banner-btn muted"
                onclick={dismissReload}>Keep mine</button
              >
            </div>
          </div>
        {/if}

        {#if saveError}
          <div class="banner error" role="alert">
            <span class="banner-text">Save failed: {saveError}</span>
            <button
              type="button"
              class="banner-btn muted"
              onclick={() => (saveError = null)}>Dismiss</button
            >
          </div>
        {/if}
      </div>
    </div>
  </main>
{/if}

{#if commandPaletteOpen}
  <CommandPalette onClose={() => (commandPaletteOpen = false)} />
{/if}

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    /* Positioned so the floating frontmatter panel (position: absolute)
       anchors to `main` rather than the viewport — matters if the outer
       layout ever gains a margin or transform. */
    position: relative;
  }

  .layout {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .workspace {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--skrive-bg);
    position: relative;
  }

  .no-tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .no-tab p {
    color: var(--skrive-muted);
    font-size: 0.875rem;
  }

  .banner {
    position: absolute;
    left: 50%;
    bottom: 1rem;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: var(--skrive-fg);
    color: var(--skrive-bg);
    font-size: 12px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    max-width: calc(100% - 2rem);
  }

  .banner.error {
    background: #a84030;
    color: #fff;
  }

  .banner-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 24rem;
  }

  .banner-actions {
    display: flex;
    gap: 0.25rem;
  }

  .banner-btn {
    background: transparent;
    border: 1px solid currentColor;
    color: inherit;
    font: inherit;
    font-size: 11px;
    padding: 0.25rem 0.5rem;
    border-radius: 3px;
    cursor: pointer;
  }

  .banner-btn.muted {
    border-color: rgba(255, 255, 255, 0.4);
  }

  .banner-btn:hover {
    background: rgba(255, 255, 255, 0.12);
  }
</style>
