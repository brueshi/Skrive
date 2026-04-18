<script lang="ts">
  // The sidebar. Alphabetical, directory-grouped file list with an inline
  // "new file" / "new folder" row, a currently-open highlight, and right-
  // click (or Delete-key) deletion via the OS trash.
  //
  // Grouping rule: files at the project root sit at the top of the list;
  // files inside directories are nested one level per directory. We do not
  // render an actual tree widget — the list is flat but indented, which
  // matches how writers think about project structure (one flat list of
  // docs, with folders as soft grouping rather than hierarchy to navigate).
  //
  // Collapse state for groups is deliberately not in this component yet.
  // Once folders become dense enough to need collapsing, we'll add it. The
  // current design assumes projects on the order of tens-to-low-hundreds of
  // files, not thousands.

  import { project } from "$lib/stores/project.svelte";
  import { preferences } from "$lib/stores/preferences.svelte";
  import { notify } from "$lib/stores/notifications.svelte";
  import { formatError } from "$lib/errors";
  import IconPlus from "$lib/icons/IconPlus.svelte";
  import ContextMenu, {
    type ContextMenuItem,
  } from "$lib/components/ContextMenu.svelte";
  import DeleteConfirmModal from "$lib/components/DeleteConfirmModal.svelte";
  import type { FileEntry } from "$lib/types";

  // Creating state is a tri-state rather than two booleans so the "new file"
  // and "new folder" flows can't both be open at once.
  let creating = $state<"file" | "folder" | null>(null);
  let newName = $state("");
  let createError = $state<string | null>(null);

  // Pending delete target. When non-null, DeleteConfirmModal is mounted.
  type DeleteTarget = { kind: "file" | "directory"; path: string; name: string };
  let pendingDelete = $state<DeleteTarget | null>(null);

  // Right-click context menu. Null when hidden.
  type ContextMenuState = { x: number; y: number; items: ContextMenuItem[] };
  let contextMenu = $state<ContextMenuState | null>(null);

  // The "+" toolbar button opens a menu of create actions — it's anchored
  // to the button position rather than mouse coords.
  let plusButtonEl: HTMLButtonElement | null = $state(null);

  type Group = {
    dir: string; // "" for project root
    files: FileEntry[];
  };

  // Build a grouped, alphabetized view over the manifest's file list. The
  // manifest itself is unsorted and unstructured — grouping is a presentation
  // concern that belongs here.
  let groups = $derived.by<Group[]>(() => {
    const files = project.manifest?.files ?? [];
    const byDir = new Map<string, FileEntry[]>();
    for (const f of files) {
      const lastSep = f.path.lastIndexOf("/");
      const dir = lastSep === -1 ? "" : f.path.slice(0, lastSep);
      const bucket = byDir.get(dir);
      if (bucket) bucket.push(f);
      else byDir.set(dir, [f]);
    }
    const sortedDirs = Array.from(byDir.keys()).sort((a, b) => {
      // Root first, then directories alphabetically. This puts
      // project-level docs (README, index) above the folder stacks.
      if (a === "") return -1;
      if (b === "") return 1;
      return a.localeCompare(b);
    });
    return sortedDirs.map((dir) => ({
      dir,
      files: (byDir.get(dir) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  });

  async function handleOpenFile(path: string) {
    try {
      await project.openTab(path);
    } catch (e) {
      notify.error(`Couldn't open ${path}: ${formatError(e)}`, e);
    }
  }

  // ---------- Creation flow (file / folder) ----------

  function startCreate(kind: "file" | "folder") {
    creating = kind;
    newName = "";
    createError = null;
  }

  async function confirmCreate() {
    const trimmed = newName.trim();
    if (!trimmed) {
      cancelCreate();
      return;
    }
    try {
      if (creating === "file") {
        const fullName = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
        await project.createFile(fullName);
      } else if (creating === "folder") {
        await project.createDirectory(trimmed);
      }
      creating = null;
      newName = "";
      createError = null;
    } catch (e) {
      createError = formatError(e);
    }
  }

  function cancelCreate() {
    creating = null;
    newName = "";
    createError = null;
  }

  function handleNewKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelCreate();
    }
  }

  function openPlusMenu() {
    if (!plusButtonEl || creating) return;
    const rect = plusButtonEl.getBoundingClientRect();
    contextMenu = {
      x: rect.left,
      y: rect.bottom + 2,
      items: [
        { label: "New file", onClick: () => startCreate("file") },
        { label: "New folder", onClick: () => startCreate("folder") },
      ],
    };
  }

  // ---------- Delete flow ----------

  function requestDeleteFile(file: FileEntry) {
    const target: DeleteTarget = {
      kind: "file",
      path: file.path,
      name: file.name,
    };
    if (preferences.skipDeleteConfirmation) {
      void runDelete(target);
    } else {
      pendingDelete = target;
    }
  }

  function requestDeleteDirectory(dir: string) {
    // The visible name is the last segment of the relative path.
    const lastSep = dir.lastIndexOf("/");
    const name = lastSep === -1 ? dir : dir.slice(lastSep + 1);
    const target: DeleteTarget = { kind: "directory", path: dir, name };
    if (preferences.skipDeleteConfirmation) {
      void runDelete(target);
    } else {
      pendingDelete = target;
    }
  }

  async function runDelete(target: DeleteTarget) {
    try {
      if (target.kind === "file") {
        await project.deleteFile(target.path);
      } else {
        await project.deleteDirectory(target.path);
      }
    } catch (e) {
      // The modal path surfaces errors inline via DeleteConfirmModal's
      // own try/catch. The silent path (skip-confirmation preference)
      // has nowhere to render inline, so toast it.
      notify.error(`Couldn't delete ${target.name}: ${formatError(e)}`, e);
    }
  }

  async function confirmPendingDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    if (target.kind === "file") {
      await project.deleteFile(target.path);
    } else {
      await project.deleteDirectory(target.path);
    }
  }

  // ---------- Context-menu triggers ----------

  function openFileContextMenu(e: MouseEvent, file: FileEntry) {
    e.preventDefault();
    contextMenu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Delete…",
          shortcut: "⌫",
          variant: "destructive",
          onClick: () => requestDeleteFile(file),
        },
      ],
    };
  }

  function openDirectoryContextMenu(e: MouseEvent, dir: string) {
    e.preventDefault();
    contextMenu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Delete folder…",
          shortcut: "⌫",
          variant: "destructive",
          onClick: () => requestDeleteDirectory(dir),
        },
      ],
    };
  }

  // ---------- Keyboard delete on focused row ----------

  function handleFileKey(e: KeyboardEvent, file: FileEntry) {
    // Delete / Backspace (plus Mac's Cmd-Backspace) triggers the delete
    // flow. We deliberately don't gate on metaKey — a bare Backspace on
    // a focused sidebar row matches VS Code / Finder behavior and the
    // confirmation modal is the safety net.
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      requestDeleteFile(file);
    }
  }

  function handleDirectoryKey(e: KeyboardEvent, dir: string) {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      requestDeleteDirectory(dir);
    }
  }
</script>

<aside
  class="sidebar"
  class:collapsed={!project.sidebarVisible}
  aria-label="Files"
  aria-hidden={!project.sidebarVisible}
  inert={!project.sidebarVisible}
>
  <header class="section-header">
    <span class="title">Files</span>
    <button
      bind:this={plusButtonEl}
      type="button"
      class="icon-button"
      aria-label="New file or folder"
      title="New file or folder"
      onclick={openPlusMenu}
      disabled={creating !== null}
    >
      <IconPlus size={16} />
    </button>
  </header>

  {#if creating !== null}
    <div class="new-file-row">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        bind:value={newName}
        onkeydown={handleNewKey}
        onblur={confirmCreate}
        placeholder={creating === "file" ? "filename.md" : "folder-name"}
        autofocus
      />
      {#if createError}
        <p class="create-error">{createError}</p>
      {/if}
    </div>
  {/if}

  {#if (project.manifest?.files.length ?? 0) === 0 && creating === null}
    <p class="empty-hint">
      This project has no markdown files yet. Click <strong>+</strong> to create
      one.
    </p>
  {/if}

  <div class="file-groups">
    {#each groups as group (group.dir)}
      {#if group.dir !== ""}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="dir-label"
          title={group.dir}
          tabindex="0"
          role="button"
          oncontextmenu={(e) => openDirectoryContextMenu(e, group.dir)}
          onkeydown={(e) => handleDirectoryKey(e, group.dir)}
        >
          {group.dir}
        </div>
      {/if}
      <ul class="files" class:nested={group.dir !== ""}>
        {#each group.files as file (file.path)}
          <li>
            <button
              type="button"
              class="file"
              class:active={project.activeTab?.path === file.path}
              onclick={() => handleOpenFile(file.path)}
              oncontextmenu={(e) => openFileContextMenu(e, file)}
              onkeydown={(e) => handleFileKey(e, file)}
              title={file.path}
            >
              {file.name}
            </button>
          </li>
        {/each}
      </ul>
    {/each}
  </div>
</aside>

{#if contextMenu}
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    items={contextMenu.items}
    onDismiss={() => {
      contextMenu = null;
    }}
  />
{/if}

{#if pendingDelete}
  <DeleteConfirmModal
    name={pendingDelete.name}
    isDirectory={pendingDelete.kind === "directory"}
    onConfirm={confirmPendingDelete}
    onClose={() => {
      pendingDelete = null;
    }}
  />
{/if}

<style>
  .sidebar {
    width: 260px;
    flex-shrink: 0;
    border-right: 1px solid var(--skrive-rule);
    overflow: hidden auto;
    background: var(--skrive-bg);
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    transition:
      width 180ms cubic-bezier(0.4, 0, 0.2, 1),
      border-right-width 180ms cubic-bezier(0.4, 0, 0.2, 1),
      opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Collapsed state: slide closed by animating width to 0. Sibling flex
     content (the workspace) grows smoothly in the freed space. The
     border collapses too so the 1px rule doesn't linger as a stub, and
     opacity fades the contents in the final frames to keep the close
     from looking like content was cut off mid-animation. */
  .sidebar.collapsed {
    width: 0;
    border-right-width: 0;
    opacity: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar {
      transition: none;
    }
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem 0.5rem;
    position: sticky;
    top: 0;
    background: var(--skrive-bg);
    z-index: 1;
  }

  .title {
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--skrive-muted);
  }

  .icon-button {
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    cursor: pointer;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: 3px;
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .icon-button:hover:not(:disabled) {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  .icon-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .new-file-row {
    padding: 0.25rem 1rem 0.5rem;
  }

  .new-file-row input {
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--skrive-fg);
    border-radius: 3px;
    background: var(--skrive-bg);
    color: var(--skrive-fg);
    font: inherit;
    font-size: 13px;
    box-sizing: border-box;
  }

  .new-file-row input:focus {
    outline: none;
  }

  .create-error {
    margin: 0.25rem 0 0;
    font-size: 11px;
    color: #a84030;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .empty-hint {
    padding: 1rem;
    margin: 0;
    font-size: 12px;
    color: var(--skrive-muted);
    line-height: 1.5;
  }

  .empty-hint strong {
    color: var(--skrive-fg);
    font-weight: 600;
  }

  .file-groups {
    flex: 1;
    min-height: 0;
  }

  .dir-label {
    padding: 0.75rem 1rem 0.25rem;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--skrive-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: default;
  }

  .dir-label:focus {
    outline: none;
    color: var(--skrive-fg);
    background: var(--skrive-rule);
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
    padding: 0.375rem 1rem;
    font: inherit;
    color: var(--skrive-fg);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .files.nested .file {
    padding-left: 1.75rem;
  }

  .file:hover {
    background: var(--skrive-rule);
  }

  .file:focus {
    outline: none;
    background: var(--skrive-rule);
  }

  .file.active {
    background: var(--skrive-rule);
    border-left-color: var(--skrive-fg);
  }
</style>
