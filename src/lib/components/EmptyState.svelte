<script lang="ts">
  // Shown when no project is loaded. Two paths forward: open an existing
  // directory, or create a new one via NewProjectDialog. When the user
  // has history, a recent-projects list sits above the buttons so the
  // most common action — reopening a project — is one click.

  import { project } from "$lib/stores/project.svelte";
  import { preferences } from "$lib/stores/preferences.svelte";
  import { pickProjectDirectory } from "$lib/dialog";
  import { formatError } from "$lib/errors";
  import { notify } from "$lib/stores/notifications.svelte";
  import NewProjectDialog from "./NewProjectDialog.svelte";
  import IconX from "$lib/icons/IconX.svelte";

  let error = $state<string | null>(null);
  let busy = $state(false);
  let showNewDialog = $state(false);

  // We display up to 6 recent projects. Preferences caps the list at 10
  // but showing all 10 crowds the screen on smaller displays — the tail
  // entries are always one click away via the eventual project menu.
  const DISPLAY_CAP = 6;

  let recent = $derived(preferences.recentProjects.slice(0, DISPLAY_CAP));

  async function handleOpen() {
    error = null;
    busy = true;
    try {
      const path = await pickProjectDirectory();
      if (path) {
        await project.openProject(path);
      }
    } catch (e) {
      error = formatError(e);
    } finally {
      busy = false;
    }
  }

  function handleNew() {
    error = null;
    showNewDialog = true;
  }

  async function openRecent(path: string) {
    if (busy) return;
    error = null;
    busy = true;
    try {
      await project.openProject(path);
    } catch (e) {
      // The folder may have moved or been deleted since it was last
      // opened. Surface the error inline and let the user prune the
      // entry from the recent list.
      error = formatError(e);
      notify.error(`Couldn't open ${path}: ${formatError(e)}`, e);
    } finally {
      busy = false;
    }
  }

  function removeRecent(e: Event, path: string) {
    e.stopPropagation();
    preferences.removeRecentProject(path);
  }
</script>

<div class="empty-state">
  <div class="inner">
    <h1>Skrive</h1>
    <p class="tagline">Write seriously.</p>

    {#if recent.length > 0}
      <ul class="recent" aria-label="Recent projects">
        {#each recent as entry (entry.path)}
          <li>
            <button
              type="button"
              class="recent-row"
              onclick={() => openRecent(entry.path)}
              disabled={busy}
              title={entry.path}
            >
              <span class="recent-name">{entry.name}</span>
              <span class="recent-path">{entry.path}</span>
              <span
                class="recent-remove"
                role="button"
                tabindex="-1"
                aria-label="Remove from recent"
                onclick={(e) => removeRecent(e, entry.path)}
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    removeRecent(e, entry.path);
                }}
              >
                <IconX size={16} />
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="actions">
      <button
        type="button"
        class="primary"
        onclick={handleOpen}
        disabled={busy}
      >
        {busy ? "Opening…" : "Open project…"}
      </button>
      <button
        type="button"
        class="secondary"
        onclick={handleNew}
        disabled={busy}
      >
        Create new project…
      </button>
    </div>
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>
</div>

{#if showNewDialog}
  <NewProjectDialog onClose={() => (showNewDialog = false)} />
{/if}

<style>
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    width: 100vw;
  }

  .inner {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    max-width: 36rem;
    padding: 2rem;
    width: 100%;
    box-sizing: border-box;
  }

  h1 {
    font-size: 4rem;
    font-weight: 600;
    letter-spacing: -0.04em;
    margin: 0;
    color: var(--skrive-fg);
  }

  .tagline {
    margin: 0;
    font-size: 1.0625rem;
    color: var(--skrive-muted);
    letter-spacing: 0.02em;
  }

  .recent {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    text-align: left;
  }

  .recent-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.75rem;
    align-items: baseline;
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font: inherit;
    color: var(--skrive-fg);
    cursor: pointer;
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
    min-width: 0;
  }

  .recent-row:hover:not(:disabled) {
    background: var(--skrive-rule);
    border-color: var(--skrive-rule);
  }

  .recent-row:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .recent-name {
    font-weight: 600;
    font-size: 0.9375rem;
  }

  .recent-path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    color: var(--skrive-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .recent-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border-radius: 2px;
    color: var(--skrive-muted);
    opacity: 0;
    transition:
      opacity 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .recent-row:hover .recent-remove {
    opacity: 1;
  }

  .recent-remove:hover {
    color: var(--skrive-fg);
    background: var(--skrive-bg);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  button {
    padding: 0.625rem 1.5rem;
    font: inherit;
    font-size: 0.9375rem;
    border-radius: 4px;
    cursor: pointer;
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  button.primary {
    border: 1px solid var(--skrive-fg);
    background: transparent;
    color: var(--skrive-fg);
  }

  button.primary:hover:not(:disabled) {
    background-color: var(--skrive-fg);
    color: var(--skrive-bg);
  }

  button.secondary {
    border: 1px solid var(--skrive-rule);
    background: transparent;
    color: var(--skrive-muted);
  }

  button.secondary:hover:not(:disabled) {
    border-color: var(--skrive-fg);
    color: var(--skrive-fg);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .error {
    margin: 0;
    color: #a84030;
    font-size: 0.8125rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    max-width: 28rem;
    word-break: break-word;
  }
</style>
