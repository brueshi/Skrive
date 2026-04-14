<script lang="ts">
  // The sidebar. Alphabetical, directory-grouped file list with an inline
  // "new file" row and a currently-open highlight.
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
  import IconPlus from "$lib/icons/IconPlus.svelte";
  import type { FileEntry } from "$lib/types";

  let creatingFile = $state(false);
  let newFileName = $state("");
  let createError = $state<string | null>(null);

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
      console.error("Failed to open file:", path, e);
    }
  }

  function startCreateFile() {
    creatingFile = true;
    newFileName = "";
    createError = null;
  }

  async function confirmCreateFile() {
    const trimmed = newFileName.trim();
    if (!trimmed) {
      cancelCreateFile();
      return;
    }
    const fullName = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
    try {
      await project.createFile(fullName);
      creatingFile = false;
      newFileName = "";
      createError = null;
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    }
  }

  function cancelCreateFile() {
    creatingFile = false;
    newFileName = "";
    createError = null;
  }

  function handleNewFileKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmCreateFile();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelCreateFile();
    }
  }
</script>

<aside class="sidebar" aria-label="Files">
  <header class="section-header">
    <span class="title">Files</span>
    <button
      type="button"
      class="icon-button"
      aria-label="New file"
      title="New file"
      onclick={startCreateFile}
      disabled={creatingFile}
    >
      <IconPlus size={16} />
    </button>
  </header>

  {#if creatingFile}
    <div class="new-file-row">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        bind:value={newFileName}
        onkeydown={handleNewFileKey}
        onblur={confirmCreateFile}
        placeholder="filename.md"
        autofocus
      />
      {#if createError}
        <p class="create-error">{createError}</p>
      {/if}
    </div>
  {/if}

  {#if (project.manifest?.files.length ?? 0) === 0 && !creatingFile}
    <p class="empty-hint">
      This project has no markdown files yet. Click <strong>+</strong> to create
      one.
    </p>
  {/if}

  <div class="file-groups">
    {#each groups as group (group.dir)}
      {#if group.dir !== ""}
        <div class="dir-label" title={group.dir}>{group.dir}</div>
      {/if}
      <ul class="files" class:nested={group.dir !== ""}>
        {#each group.files as file (file.path)}
          <li>
            <button
              type="button"
              class="file"
              class:active={project.activeTab?.path === file.path}
              onclick={() => handleOpenFile(file.path)}
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

<style>
  .sidebar {
    width: 260px;
    flex-shrink: 0;
    border-right: 1px solid var(--skrive-rule);
    overflow-y: auto;
    background: var(--skrive-bg);
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    min-height: 0;
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

  .file.active {
    background: var(--skrive-rule);
    border-left-color: var(--skrive-fg);
  }
</style>
