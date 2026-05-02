<script lang="ts">
  // The sidebar. Recursive directory tree with an inline "new file" /
  // "new folder" row, a currently-open highlight, and right-click (or
  // Delete-key) deletion via the OS trash.
  //
  // Tree model: a TreeFolder carries its leaf name + full project-
  // relative path plus its child folders and files. The synthetic root
  // TreeFolder represents the project root; its files render at the
  // top of the sidebar (preserving the prior "root files first"
  // reading order), and its child folders render below.
  //
  // Expand/collapse state lives in `collapsedPaths` — a Set of folder
  // paths the user has collapsed. Default is fully expanded (matches
  // the prior always-visible behavior). Per-project persistence lands
  // with the broader preferences pass; for now state is in-memory.

  import { onDestroy } from "svelte";
  import {
    project,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_DEFAULT_WIDTH,
  } from "$lib/stores/project.svelte";
  import { preferences } from "$lib/stores/preferences.svelte";
  import { notify } from "$lib/stores/notifications.svelte";
  import { formatError } from "$lib/errors";
  import IconPlus from "$lib/icons/IconPlus.svelte";
  import IconFolder from "$lib/icons/IconFolder.svelte";
  import IconDocMarkdown from "$lib/icons/IconDocMarkdown.svelte";
  import ContextMenu, {
    type ContextMenuItem,
  } from "$lib/components/ContextMenu.svelte";
  import DeleteConfirmModal from "$lib/components/DeleteConfirmModal.svelte";
  import type { FileEntry } from "$lib/types";
  import { resolveTitle } from "$lib/title";

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

  type TreeFolder = {
    /** Leaf folder name (e.g., "chapter-3"). Empty string on the synthetic root. */
    name: string;
    /** Full project-relative path (e.g., "drafts/chapter-3"). Empty string on root. */
    path: string;
    folders: TreeFolder[];
    files: FileEntry[];
  };

  // Build a recursive tree from the manifest's flat file list. Folders are
  // synthesized from each file's path components. Empty folders (created
  // via createDirectory but not yet containing any files) don't appear —
  // the manifest only carries files, mirroring prior behavior.
  let tree = $derived.by<TreeFolder>(() => {
    const root: TreeFolder = { name: "", path: "", folders: [], files: [] };
    const byPath = new Map<string, TreeFolder>();
    byPath.set("", root);

    const files = project.manifest?.files ?? [];
    for (const f of files) {
      const lastSep = f.path.lastIndexOf("/");
      if (lastSep === -1) {
        root.files.push(f);
        continue;
      }
      const parts = f.path.slice(0, lastSep).split("/");
      let parent = root;
      let runningPath = "";
      for (const part of parts) {
        runningPath = runningPath ? `${runningPath}/${part}` : part;
        let next = byPath.get(runningPath);
        if (!next) {
          next = { name: part, path: runningPath, folders: [], files: [] };
          parent.folders.push(next);
          byPath.set(runningPath, next);
        }
        parent = next;
      }
      parent.files.push(f);
    }

    // Sort each level: folders alphabetically, files alphabetically.
    // Within a folder, files render before sub-folders — preserves the
    // prior "root files first" reading order, applied recursively.
    const sortFolder = (folder: TreeFolder) => {
      folder.folders.sort((a, b) => a.name.localeCompare(b.name));
      folder.files.sort((a, b) => a.name.localeCompare(b.name));
      folder.folders.forEach(sortFolder);
    };
    sortFolder(root);

    return root;
  });

  // Folder paths the user has collapsed. Membership = collapsed; absence
  // = expanded. Default: empty set, so every folder is expanded — matches
  // the prior always-visible behavior.
  let collapsedPaths = $state(new Set<string>());

  function toggleCollapse(path: string) {
    // Replace the Set rather than mutating it — Svelte 5 reactivity
    // tracks reassignment, not mutation, on $state-wrapped Sets.
    const next = new Set(collapsedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsedPaths = next;
  }

  function isExpanded(path: string): boolean {
    return !collapsedPaths.has(path);
  }

  // Compose the inline style for a row's ancestor-spine background.
  // Each entry in `spineDepths` is a depth-d column where a full-height
  // 1px stripe should draw. The function builds a multi-layer
  // background-image / position / size / repeat declaration — one
  // linear-gradient per spine. Returns an empty string when no spines
  // need drawing (depth-0 rows, last-leaf chains, etc.).
  function buildSpineStyle(spineDepths: number[]): string {
    if (spineDepths.length === 0) return "";
    const stripe =
      "linear-gradient(to right, var(--skrive-rule) 0, var(--skrive-rule) 1px, transparent 1px)";
    const images = spineDepths.map(() => stripe).join(", ");
    const positions = spineDepths
      .map((d) => `calc(1rem + ${d} * var(--sb-indent-step)) 0`)
      .join(", ");
    const sizes = spineDepths.map(() => "1px 100%").join(", ");
    const repeats = spineDepths.map(() => "no-repeat").join(", ");
    return `background-image: ${images}; background-position: ${positions}; background-size: ${sizes}; background-repeat: ${repeats};`;
  }

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
          label: "Rename…",
          shortcut: "F2",
          onClick: () => project.openRenameModal(file.path),
        },
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
    } else if (e.key === "Enter" || e.key === " ") {
      // Activation keys for the row's button role — toggle expand/collapse.
      e.preventDefault();
      toggleCollapse(dir);
    }
  }

  // ---------- Drag-to-resize ----------
  //
  // Pointerdown on the handle captures the starting mouse x and the
  // current sidebar width, then document-level pointermove/pointerup
  // drive the resize until the button lifts. We park the cursor and
  // `user-select` overrides on <body> during drag so the pointer stays
  // `col-resize` even when it wanders off the narrow hit zone, and so
  // selecting text in the editor mid-drag doesn't hijack the gesture.
  //
  // Double-click on the handle resets to the default width — common
  // divider idiom and a quick escape hatch if the user drags too wide.

  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartWidth = 0;

  function startDrag(e: PointerEvent) {
    if (e.button !== 0) return; // primary button only
    e.preventDefault();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartWidth = project.sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", endDrag, { once: true });
  }

  function onDragMove(e: PointerEvent) {
    project.setSidebarWidth(dragStartWidth + (e.clientX - dragStartX));
  }

  function endDrag() {
    isDragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onDragMove);
  }

  onDestroy(() => {
    // If the component is torn down mid-drag (project closed, etc.),
    // leave the document in a clean state.
    if (isDragging) endDrag();
  });

  function resetWidth() {
    project.setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }
</script>

<aside
  class="sidebar"
  class:collapsed={!project.sidebarVisible}
  class:dragging={isDragging}
  style="--skrive-sidebar-width: {project.sidebarWidth}px"
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

  {#snippet fileRow(
    file: FileEntry,
    depth: number,
    lastChild: boolean,
    parentChain: boolean[],
  )}
    {@const chain = depth > 0 ? [...parentChain, lastChild] : []}
    {@const spineDepths = chain
      .map((isLast, i) => (isLast ? -1 : i))
      .filter((d) => d >= 0)}
    {@const resolved = resolveTitle(file)}
    <li>
      <button
        type="button"
        class="file"
        class:active={project.activeTab?.path === file.path}
        style="--sb-depth: {depth}; {buildSpineStyle(spineDepths)}"
        onclick={() => handleOpenFile(file.path)}
        oncontextmenu={(e) => openFileContextMenu(e, file)}
        onkeydown={(e) => handleFileKey(e, file)}
        title={file.path}
      >
        <span class="file-icon"><IconDocMarkdown size={16} /></span>
        <span class="file-labels">
          <span class="file-title">{resolved.primary}</span>
          {#if resolved.secondary}
            <span class="file-filename">{resolved.secondary}</span>
          {/if}
        </span>
      </button>
    </li>
  {/snippet}

  {#snippet folderTree(
    folder: TreeFolder,
    depth: number,
    lastChild: boolean,
    parentChain: boolean[],
  )}
    {@const chain = depth > 0 ? [...parentChain, lastChild] : []}
    {@const spineDepths = chain
      .map((isLast, i) => (isLast ? -1 : i))
      .filter((d) => d >= 0)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="dir-label"
      title={folder.path}
      tabindex="0"
      role="button"
      aria-expanded={isExpanded(folder.path)}
      style="--sb-depth: {depth}; {buildSpineStyle(spineDepths)}"
      onclick={() => toggleCollapse(folder.path)}
      onkeydown={(e) => handleDirectoryKey(e, folder.path)}
      oncontextmenu={(e) => openDirectoryContextMenu(e, folder.path)}
    >
      <span class="dir-icon">
        <IconFolder size={16} open={isExpanded(folder.path)} />
      </span>
      <span class="dir-name">{folder.name}</span>
    </div>
    {#if isExpanded(folder.path)}
      {#if folder.files.length > 0}
        <ul class="files">
          {#each folder.files as file, i (file.path)}
            {@render fileRow(
              file,
              depth + 1,
              i === folder.files.length - 1 && folder.folders.length === 0,
              chain,
            )}
          {/each}
        </ul>
      {/if}
      {#each folder.folders as sub, i (sub.path)}
        {@render folderTree(
          sub,
          depth + 1,
          i === folder.folders.length - 1,
          chain,
        )}
      {/each}
    {/if}
  {/snippet}

  <div class="file-groups">
    {#if tree.files.length > 0}
      <ul class="files">
        {#each tree.files as file, i (file.path)}
          {@render fileRow(
            file,
            0,
            i === tree.files.length - 1 && tree.folders.length === 0,
            [],
          )}
        {/each}
      </ul>
    {/if}
    {#each tree.folders as folder, i (folder.path)}
      {@render folderTree(folder, 0, i === tree.folders.length - 1, [])}
    {/each}
  </div>
</aside>

{#if project.sidebarVisible}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
  <div
    class="resize-handle"
    class:dragging={isDragging}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    aria-valuenow={project.sidebarWidth}
    aria-valuemin={SIDEBAR_MIN_WIDTH}
    aria-valuemax={SIDEBAR_MAX_WIDTH}
    onpointerdown={startDrag}
    ondblclick={resetWidth}
  ></div>
{/if}

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
    /* Indent step per nesting depth. Wide enough to give the L-elbow
       connector horizontal room to read as a tree branch (~0.75rem of
       elbow stub) rather than a flush tick mark. Tune here to re-balance
       tree density vs. elbow legibility in one place. */
    --sb-indent-step: 1.25rem;

    width: var(--skrive-sidebar-width, 260px);
    flex-shrink: 0;
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
      opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Collapsed state: slide closed by animating width to 0. Sibling flex
     content (the workspace) grows smoothly in the freed space. Opacity
     fades the contents in the final frames to keep the close from
     looking like content was cut off mid-animation. */
  .sidebar.collapsed {
    width: 0;
    opacity: 0;
  }

  /* During a drag, suppress the width transition so the sidebar tracks
     the pointer frame-by-frame instead of easing toward each new width. */
  .sidebar.dragging {
    transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar {
      transition: none;
    }
  }

  /* The drag handle lives as a sibling flex-item between the sidebar and
     the workspace. A 4px-wide transparent strip gives the pointer a
     generous hit zone, while the 1px inner line (rendered via ::before)
     acts as the visible rule that the old `border-right` used to draw. */
  .resize-handle {
    width: 4px;
    flex-shrink: 0;
    cursor: col-resize;
    position: relative;
    background: transparent;
    user-select: none;
    -webkit-user-select: none;
  }

  .resize-handle::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    background: var(--skrive-rule);
    transition: background 120ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  .resize-handle:hover::before,
  .resize-handle.dragging::before {
    background: var(--skrive-fg);
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

  /* Folder rows. The morphing folder glyph (open/closed pocket line)
     replaces the prior chevron — it's both the "this is a folder"
     identification and the expand-state indicator in one element. */
  .dir-label {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 1rem;
    /* Depth-based left indent overrides the shorthand's left padding. */
    padding-left: calc(0.5rem + var(--sb-depth, 0) * var(--sb-indent-step));
    font-weight: 500;
    color: var(--skrive-fg);
    overflow: hidden;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }

  /* Use background-color (not the shorthand) so the indent-guide
     background-image survives hover/focus/active states. */
  .dir-label:hover {
    background-color: var(--skrive-rule);
  }

  .dir-label:focus {
    outline: none;
    background-color: var(--skrive-rule);
  }

  .dir-icon {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    color: var(--skrive-muted);
  }

  .dir-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* File rows. Icon column on the left, then a flex-column label stack
     that holds the resolved title and (when present) the filename
     secondary line. Truncation lives on the inner spans so each line
     ellipsizes independently.

     No border-left here — the active-state accent uses an inset
     box-shadow instead, which keeps the row's padding-edge identical
     to .dir-label. Otherwise a 2px transparent border would shift
     every file's gradient + elbow geometry 2px right of folder rows
     at the same depth, jogging the spine across folder→file boundaries. */
  .file {
    position: relative;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 0.375rem 1rem;
    /* Same indent formula as .dir-label — files have their own icon
       column, so file icons align column-wise with same-depth folder
       icons. */
    padding-left: calc(0.5rem + var(--sb-depth, 0) * var(--sb-indent-step));
    font: inherit;
    color: var(--skrive-fg);
    cursor: pointer;
    overflow: hidden;
  }

  .file-icon {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    color: var(--skrive-muted);
  }

  .file-labels {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    gap: 0.0625rem;
  }

  .file-title,
  .file-filename {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-filename {
    font-size: 11px;
    color: var(--skrive-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .file:hover {
    background-color: var(--skrive-rule);
  }

  .file:focus {
    outline: none;
    background-color: var(--skrive-rule);
  }

  .file.active {
    background-color: var(--skrive-rule);
    /* 2px accent at the row's left edge. inset box-shadow renders
       above the background but below text, doesn't displace layout. */
    box-shadow: inset 2px 0 0 var(--skrive-fg);
  }

  /* Ancestor spines are inline-styled per row by `buildSpineStyle()`
     in the script. The set of spine columns drawn on a given row is
     computed from its ancestor-lastness chain: a spine at column d is
     drawn iff the row's ancestor at depth (d+1) is NOT a last child.
     That keeps each subtree's spine confined to its own siblings —
     when an ancestor is a last child, its column-line stops at its
     own elbow rather than extending through descendants. */

  /* L-elbow connector. Half-height vertical at the row's immediate
     parent column plus a short horizontal stub at vertical-mid out to
     the row's icon column. Composes with the inline-styled spine when
     a spine is present (full-height stripe + elbow's top-half border-
     left overlap into a continuous full-height vertical with a stub at
     mid). On rows where the spine is absent (last-child chains), the
     elbow alone provides the half-height termination. The bottom-left
     radius softens the bend — echoes the rounded line caps of the icon
     set. Only renders for rows at depth ≥ 1; depth-0 rows match the
     negation selector and skip the pseudo-element. */
  .dir-label:not([style*="--sb-depth: 0;"])::before,
  .file:not([style*="--sb-depth: 0;"])::before {
    content: "";
    position: absolute;
    pointer-events: none;
    /* Parent's icon-center column: depth-(N-1) icon center sits at
       x = 1rem + (N-1) × step from the row's left padding edge. */
    left: calc(1rem + (var(--sb-depth, 0) - 1) * var(--sb-indent-step));
    top: 0;
    height: 50%;
    /* Width chosen so the horizontal stub stops just at the row's
       icon left edge — `step - 0.5rem` accounts for the half-icon
       offset between parent's icon center and the row's icon edge. */
    width: calc(var(--sb-indent-step) - 0.5rem);
    border-left: 1px solid var(--skrive-rule);
    border-bottom: 1px solid var(--skrive-rule);
    border-bottom-left-radius: 0.25rem;
  }
</style>
