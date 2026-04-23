<script lang="ts">
  // The workspace page. Composes the sidebar + header + split view and owns
  // the cross-cutting concerns that don't fit inside any one component:
  //   - global keyboard shortcuts (⌘[, ⌘1/2/3, ⌘S)
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
  import { notify } from "$lib/stores/notifications.svelte";
  import type { LayoutMode, OpenFileRequest } from "$lib/types";
  import { formatError } from "$lib/errors";
  import {
    scheduleSave,
    flushSave,
    flushAllPendingSaves,
    isRecentSelfWrite,
  } from "$lib/persistence/autosave";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import {
    restoreProjectState,
    queueSaveProjectState,
    resetProjectStateTarget,
  } from "$lib/persistence/projectState";

  import EmptyState from "$lib/components/EmptyState.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import Header from "$lib/components/Header.svelte";
  import SplitView from "$lib/components/SplitView.svelte";
  import DiffView from "$lib/components/DiffView.svelte";
  import FrontmatterPanel from "$lib/components/FrontmatterPanel.svelte";
  import PersonalDictionaryPanel from "$lib/components/PersonalDictionaryPanel.svelte";
  import BacklinksPanel from "$lib/components/BacklinksPanel.svelte";
  import HistoryPanel from "$lib/components/HistoryPanel.svelte";
  import RenameModal from "$lib/components/RenameModal.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import SearchModal from "$lib/components/SearchModal.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import {
    openProjectFromPicker,
    closeCurrentProject,
  } from "$lib/project-actions";
  import { checkForUpdatesOnStartup } from "$lib/updater";

  type WatcherPayload = {
    path: string;
    kind: "created" | "modified" | "removed";
  };

  let reloadPrompt = $state<string | null>(null);
  let commandPaletteOpen = $state(false);
  let searchModalOpen = $state(false);

  const autoSaveHooks = {
    onSaved: (path: string) => {
      project.markTabSaved(path);
    },
    onError: (path: string, err: unknown) => {
      notify.error(`Couldn't save ${path}: ${formatError(err)}`, err);
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
      notify.error(`Couldn't reload ${path}: ${formatError(err)}`, err);
    }
  }

  function dismissReload() {
    reloadPrompt = null;
  }

  // ======================== Project-open side effects ========================

  // File requested from outside (Finder double-click, single-instance CLI
  // launch, etc.) but whose project isn't the one currently open. We
  // remember the relative path here and the project-switch effect below
  // picks it up once the new project's restore + watcher are in place.
  // Kept as a plain `let` (not `$state`) so reading it inside the effect
  // doesn't create a reactive dependency that would re-trigger the run.
  let pendingFileAfterRestore: string | null = null;

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
        notify.error(
          `Couldn't restore tabs for this project: ${formatError(err)}`,
          err,
        );
      }
      try {
        await invoke("watch_project");
      } catch (err) {
        notify.error(
          `File watcher failed to start — external changes won't update: ${formatError(err)}`,
          err,
        );
      }
      // If this project-switch was driven by an open-with request, the
      // target file waits here until restore finishes so it lands as the
      // active tab rather than being buried under the restored set.
      if (pendingFileAfterRestore) {
        const target = pendingFileAfterRestore;
        pendingFileAfterRestore = null;
        try {
          await project.openTab(target);
        } catch (err) {
          notify.error(
            `Couldn't focus ${target}: ${formatError(err)}`,
            err,
          );
        }
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
    void project.sidebarWidth;
    void project.activeTabIndex;
    void project.tabs.length;
    for (const t of project.tabs) {
      void t.path;
      void t.layoutMode;
      void t.splitDividerRatio;
    }
    untrack(() => queueSaveProjectState());
  });

  // Refresh the backlinks list whenever the active tab changes. Reads
  // `activeTab?.path` so the effect re-fires on tab switches and on
  // path renames (Phase 3.1 Step 6). The fetch is cheap and lets the
  // `BL · N` indicator stay honest.
  $effect(() => {
    const _path = project.activeTab?.path ?? null;
    void _path;
    untrack(() => void project.refreshBacklinksForActive());
  });

  // Same pattern for version history. Re-fires when the active tab
  // changes and when the history mode swaps (project close → open).
  // The indicator stays honest whether the file has 0, 5, or 500
  // historical versions behind it.
  $effect(() => {
    const _path = project.activeTab?.path ?? null;
    const _mode = project.historyMode;
    void _path;
    void _mode;
    untrack(() => void project.refreshHistoryForActive());
  });

  // ======================== Keyboard shortcuts ========================

  function handleKeydown(e: KeyboardEvent) {
    // Escape exits diff mode when the active tab is inside it. Handled
    // first so the gesture feels native — "I'm done looking, take me
    // back" — without fighting modal or panel Esc handlers. Their own
    // handlers run first because they're attached to inner DOM nodes
    // and bubble here last.
    if (e.key === "Escape") {
      const tab = project.activeTab;
      if (
        tab &&
        (tab.layoutMode === "diff-raw" || tab.layoutMode === "diff-preview")
      ) {
        e.preventDefault();
        project.exitDiffMode();
        return;
      }
    }

    // F2 — rename the active tab. Bare key, Windows/Linux rename
    // convention. macOS users get the same binding plus the
    // "Rename…" entry in the sidebar's right-click menu for discovery.
    // Handled before the meta-gate below because F2 isn't modified.
    if (e.key === "F2") {
      const tab = project.activeTab;
      if (tab && !project.renameModalPath) {
        e.preventDefault();
        project.openRenameModal(tab.path);
      }
      return;
    }

    if (!(e.metaKey || e.ctrlKey)) return;

    // ⌘F opens project-wide search. We depart from the VS Code
    // convention (where ⌘F is find-in-file) because Skrive targets
    // writers more than code power-users, project search is the most
    // frequent "find" action here, and find-in-file is deliberately
    // unshipped. If we add it later, ⌘E is the slot.
    if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      if (project.hasProject) {
        e.preventDefault();
        searchModalOpen = !searchModalOpen;
      }
      return;
    }

    // ⌘⇧F toggles the frontmatter panel. Requires an active tab —
    // frontmatter is per-file and the panel has nothing to show
    // otherwise.
    if (e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      if (project.activeTab) {
        e.preventDefault();
        project.toggleFrontmatterPanel();
      }
      return;
    }

    // ⌘O opens the project picker from anywhere (including inside an
    // already-open project — switching). ⌘⇧W closes the current project
    // and returns to EmptyState. The project-menu in the header shows
    // both shortcuts alongside the menu items.
    if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void openProjectFromPicker();
      return;
    }
    if (e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
      if (project.hasProject) {
        e.preventDefault();
        void closeCurrentProject(autoSaveHooks);
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

    // ⌘⇧B toggles the backlinks panel. Requires an active tab — backlinks
    // are contextual to the file being viewed.
    if (e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
      if (project.activeTab) {
        e.preventDefault();
        project.toggleBacklinksPanel();
      }
      return;
    }

    // ⌘⇧H toggles the version-history panel. Requires an active tab —
    // history is contextual to the file being viewed, same as
    // backlinks and frontmatter.
    if (e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") {
      if (project.activeTab) {
        e.preventDefault();
        project.toggleHistoryPanel();
      }
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

    // Bracket family:
    //   ⌘[     toggles the sidebar
    //   ⌘⇧[   cycles to the previous open tab
    //   ⌘⇧]   cycles to the next open tab
    //
    // We avoid ⌘B (the VS Code sidebar convention) because ⌘B is the
    // universal "bold" shortcut in writer apps — leaving that slot open
    // keeps it free for when editor formatting shortcuts land. The tab
    // cycle matches Safari / Chrome / Terminal so it's already in
    // writers' muscle memory.
    //
    // Matched by `e.code` rather than `e.key` because shift turns `[` and
    // `]` into `{` and `}` on US keyboards, which would break the binding
    // if we compared against `e.key`.
    if (!e.altKey && e.code === "BracketLeft") {
      e.preventDefault();
      if (e.shiftKey) project.cycleActiveTab(-1);
      else project.toggleSidebar();
      return;
    }
    if (!e.altKey && e.shiftKey && e.code === "BracketRight") {
      e.preventDefault();
      project.cycleActiveTab(1);
      return;
    }

    switch (e.key.toLowerCase()) {
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
  let unlistenOpenFile: UnlistenFn | null = null;
  let unlistenClose: UnlistenFn | null = null;
  onMount(() => {
    // Hydrate app-wide preferences (personal dictionary, recent
    // projects, etc.) from disk before the rest of the UI starts
    // reading them. Failures are non-fatal — the store keeps its
    // defaults and subsequent saves write a fresh file.
    void preferences.loadOnce();

    // Silent update check. If a newer version is available, a
    // persistent call-to-action toast appears in the corner; the user
    // can install on their schedule. Errors (offline, unconfigured
    // endpoint) stay quiet — see docs on `checkForUpdatesOnStartup`.
    void checkForUpdatesOnStartup();

    (async () => {
      unlistenWatcher = await listen<WatcherPayload>(
        "project://file-changed",
        (event) => {
          handleWatcherEvent(event.payload);
        },
      );
      unlistenOpenFile = await listen<OpenFileRequest>(
        "skrive://open-file-request",
        (event) => {
          void handleOpenFileRequest(event.payload);
        },
      );

      // Drain any file request that landed before the webview was ready
      // to listen — e.g. launching Skrive by double-clicking a .md in
      // Finder. If nothing is pending the command returns null and we
      // fall through to the normal empty-state.
      try {
        const pending = await invoke<OpenFileRequest | null>(
          "take_pending_open_file",
        );
        if (pending) void handleOpenFileRequest(pending);
      } catch (err) {
        console.warn("Failed to drain pending open-file request:", err);
      }

      // Flush any in-flight autosave before the window actually closes.
      // The 1-second debounce in the autosave driver is the data-loss
      // window — a keystroke within that second that beats the user to
      // the red dot would disappear. Intercepting the close event,
      // flushing, and then explicitly destroying the window closes that
      // gap. No confirmation prompt because autosave + flush covers it.
      const appWindow = getCurrentWindow();
      unlistenClose = await appWindow.onCloseRequested(async (event) => {
        if (project.tabs.some((t) => t.dirty)) {
          event.preventDefault();
          try {
            await flushAllPendingSaves(autoSaveHooks);
          } catch (err) {
            console.warn("Flush on close failed:", err);
          }
          await appWindow.destroy();
        }
      });
    })();

    return () => {
      unlistenWatcher?.();
      unlistenOpenFile?.();
      unlistenClose?.();
      resetProjectStateTarget();
    };
  });

  async function handleOpenFileRequest(req: OpenFileRequest) {
    if (project.manifest?.root === req.projectRoot) {
      // Same project already open — straight to the file.
      try {
        await project.openTab(req.filePath);
      } catch (err) {
        notify.error(
          `Couldn't open ${req.filePath}: ${formatError(err)}`,
          err,
        );
      }
      return;
    }

    // Different (or no) project open. Queue the file and trigger the
    // switch; the project-open effect picks up the pending target after
    // restore completes so the requested file ends as the active tab.
    pendingFileAfterRestore = req.filePath;
    try {
      await project.openProject(req.projectRoot);
    } catch (err) {
      pendingFileAfterRestore = null;
      notify.error(
        `Couldn't open project ${req.projectRoot}: ${formatError(err)}`,
        err,
      );
    }
  }

  // Coalesce rapid manifest-refresh requests so a git pull (dozens of
  // created/removed events in a few hundred ms) triggers one rescan, not
  // dozens. Trailing-edge debounce — we wait for the burst to end before
  // refreshing, which is the behavior that minimizes sidebar flicker.
  const MANIFEST_REFRESH_DEBOUNCE_MS = 400;
  let manifestRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleManifestRefresh() {
    if (manifestRefreshTimer) clearTimeout(manifestRefreshTimer);
    manifestRefreshTimer = setTimeout(() => {
      manifestRefreshTimer = null;
      project.refreshManifest().catch((err) => {
        notify.error(
          `Couldn't refresh file list: ${formatError(err)}`,
          err,
        );
      });
    }, MANIFEST_REFRESH_DEBOUNCE_MS);
  }

  function handleWatcherEvent(payload: WatcherPayload) {
    const { path, kind } = payload;

    // Step 1: suppress echoes of our own write_file calls.
    if (isRecentSelfWrite(path)) return;

    // Step 2: keep the sidebar manifest in sync with external file-tree
    // changes (Finder, git pull, other editors). Our own create/delete
    // paths in the store also call refreshManifest eagerly, but they use
    // the same coalescing path so the double-trigger just no-ops.
    if (kind === "created" || kind === "removed") {
      scheduleManifestRefresh();
    }

    // Backlinks for the active file may have changed regardless of
    // which file was touched — any source's links can gain or drop a
    // reference to us. Cheap refresh; skip when there's no active tab.
    if (project.activeTab) {
      void project.refreshBacklinksForActive();
    }

    // History for the active file is a per-file stream, but an
    // external git commit or checkpoint write could land while we're
    // here. Same active-tab guard as backlinks.
    if (project.activeTab) {
      void project.refreshHistoryForActive();
    }

    // Step 3: react for any open tab that points at this path.
    const tab = project.tabs.find((t) => t.path === path);
    if (!tab) return;

    if (kind === "removed") {
      // The file vanished out from under us. Leave the content in memory so
      // the user can still save it back, but flag them.
      reloadPrompt = null;
      notify.error(`${path} was removed from disk`);
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
    <Header {autoSaveHooks} />
    <FrontmatterPanel />
    <PersonalDictionaryPanel />
    <BacklinksPanel />
    <HistoryPanel />
    {#if project.renameModalPath}
      <RenameModal
        oldPath={project.renameModalPath}
        onClose={() => project.closeRenameModal()}
        onCommit={async (newPath) => {
          const oldPath = project.renameModalPath;
          if (!oldPath) return;
          // Close the modal up front so the user sees the editor return
          // immediately; the rename itself is asynchronous but the UI
          // doesn't have anything useful to show while it waits.
          project.closeRenameModal();
          try {
            const { report, dirtyConflicts } = await project.renameFile(
              oldPath,
              newPath,
            );
            if (dirtyConflicts.length === 0) {
              const n = report.referencesUpdated;
              const m = report.filesWritten.length;
              notify.success(
                `Renamed. ${n} ${n === 1 ? "reference" : "references"} updated across ${m} ${m === 1 ? "file" : "files"}.`,
              );
            } else {
              // Dirty tabs whose on-disk content changed under them:
              // we kept the buffer intact so the user can save or
              // discard on their own terms. Name the files so they
              // can find them.
              notify.error(
                `Renamed ${oldPath} → ${newPath}, but ${dirtyConflicts.length} open tab${dirtyConflicts.length === 1 ? " has" : "s have"} unsaved edits and weren't reloaded: ${dirtyConflicts.join(", ")}`,
              );
            }
          } catch (err) {
            notify.error(
              `Couldn't rename ${oldPath} → ${newPath}: ${formatError(err)}`,
              err,
            );
          }
        }}
      />
    {/if}
    <div class="layout">
      <Sidebar />
      <div class="workspace">
        {#if project.activeTab}
          {#key project.activeTab.path}
            {#if (project.activeTab.layoutMode === "diff-raw" || project.activeTab.layoutMode === "diff-preview") && project.activeTab.diff}
              <DiffView
                mode={project.activeTab.layoutMode}
                before={project.activeTab.diff.before}
                after={project.activeTab.diff.after}
                dividerRatio={project.activeTab.diff.dividerRatio}
                rows={project.activeTab.diff.rows}
              />
            {:else}
              <SplitView
                mode={project.activeTab.layoutMode}
                ratio={project.activeTab.splitDividerRatio}
                body={activeBody}
                onChange={handleChange}
                selection={project.activeTab.pendingSelection}
              />
            {/if}
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

      </div>
    </div>
  </main>
{/if}

{#if commandPaletteOpen}
  <CommandPalette onClose={() => (commandPaletteOpen = false)} />
{/if}

{#if searchModalOpen}
  <SearchModal onClose={() => (searchModalOpen = false)} />
{/if}

<Toasts />

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
