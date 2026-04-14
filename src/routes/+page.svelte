<script lang="ts">
  import { project } from "$lib/stores/project.svelte";
  import Editor from "$lib/editor/Editor.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import DebugFileList from "$lib/components/DebugFileList.svelte";

  function handleChange(body: string) {
    project.updateActiveTabContent(body);
  }

  // The current project's display name. Canonical root paths come back from
  // the Rust core in OS-native form; we take the trailing component as the
  // project name for the header.
  let projectName = $derived.by(() => {
    const root = project.manifest?.root;
    if (!root) return "";
    const parts = root.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? root;
  });
</script>

{#if !project.hasProject}
  <EmptyState />
{:else}
  <main>
    <header class="app-header">
      <span class="brand">Skrive</span>
      <span class="project-name">{projectName}</span>
    </header>
    <div class="layout">
      <DebugFileList />
      <div class="editor-host">
        {#if project.activeTab}
          {#key project.activeTab.path}
            <Editor
              value={project.activeTab.content.body}
              onChange={handleChange}
            />
          {/key}
        {:else}
          <div class="no-tab">
            <p>Click a file on the left to open it.</p>
          </div>
        {/if}
      </div>
    </div>
  </main>
{/if}

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
  }

  .app-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0.75rem 1.5rem;
    border-bottom: 1px solid var(--skrive-rule);
    flex-shrink: 0;
  }

  .brand {
    font-weight: 600;
    letter-spacing: -0.01em;
    font-size: 0.95rem;
    color: var(--skrive-fg);
  }

  .project-name {
    font-size: 0.75rem;
    color: var(--skrive-muted);
    letter-spacing: 0.04em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .layout {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .editor-host {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--skrive-bg);
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
</style>
