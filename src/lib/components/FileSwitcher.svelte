<script lang="ts">
  // ⌘P file switcher. Sibling of CommandPalette.svelte (the ⌘⇧P
  // command runner) — both share the fuzzy ranker and the Enter /
  // ↑ / ↓ / Esc gesture vocabulary, but this one's haystack is the
  // project's file manifest.
  //
  // Behavior:
  //   - Empty query: show recent files for the current project, most
  //     recent first. Stale entries (file gone from disk) are filtered
  //     and silently cleaned from the persisted list on render.
  //   - Typed query: fuzzy-score every file in the manifest by full
  //     project-relative path; show best-N.
  //   - ↑/↓ move the selection, Enter opens, Esc dismisses.
  //
  // The switcher is stateless about which file is selected after Enter —
  // that's the project store's business. We just call `openTab` and the
  // store updates recent files as a side effect.

  import { tick } from "svelte";
  import { project } from "$lib/stores/project.svelte";
  import { preferences } from "$lib/stores/preferences.svelte";
  import { notify } from "$lib/stores/notifications.svelte";
  import { rankItems, type ScoredEntry } from "$lib/editor/fuzzy";
  import { formatError } from "$lib/errors";
  import type { FileEntry } from "$lib/types";

  type Props = {
    onClose: () => void;
  };

  let { onClose }: Props = $props();

  let query = $state("");
  let selectedIndex = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);
  let listEl: HTMLDivElement | null = $state(null);

  // Cap on rendered result rows. Even on a 1k-file project, this keeps
  // the DOM small and scanning the top few is what writers actually do.
  const MAX_RESULTS = 20;

  // Index files by path so recent-file entries can hydrate into full
  // FileEntry objects and we can drop entries that no longer exist.
  const fileByPath = $derived.by<Map<string, FileEntry>>(() => {
    const map = new Map<string, FileEntry>();
    for (const f of project.manifest?.files ?? []) {
      map.set(f.path, f);
    }
    return map;
  });

  // Default (empty-query) list: recent files for the current project that
  // still exist on disk. Side-effect: clean stale entries out of the
  // persisted recent-files list so the next session isn't cluttered.
  const defaultEntries = $derived.by<FileEntry[]>(() => {
    const root = project.manifest?.root;
    if (!root) return [];
    const out: FileEntry[] = [];
    for (const r of preferences.recentFiles) {
      if (r.projectPath !== root) continue;
      const entry = fileByPath.get(r.filePath);
      if (entry) {
        out.push(entry);
      } else {
        // File listed in the LRU no longer exists — drop it.
        // removeRecentFile schedules a debounced save, so repeated
        // calls here are safe.
        preferences.removeRecentFile(r.projectPath, r.filePath);
      }
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  });

  const allFiles = $derived.by<FileEntry[]>(
    () => project.manifest?.files ?? [],
  );

  // Results displayed in the list. Empty query uses the recent-files
  // default; non-empty fuzzy-ranks every file in the project.
  const results = $derived.by<ScoredEntry<FileEntry>[]>(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return defaultEntries.map((item) => ({ item, score: 0, indices: [] }));
    }
    const scored = rankItems(trimmed, allFiles, (f) => f.path);
    return scored.slice(0, MAX_RESULTS);
  });

  // When results change, keep the selection in bounds. Reset to the top
  // whenever the query changes so the cursor always points at the best
  // match after a keystroke.
  $effect(() => {
    void query;
    selectedIndex = 0;
  });

  $effect(() => {
    if (selectedIndex >= results.length) {
      selectedIndex = Math.max(0, results.length - 1);
    }
  });

  async function scrollSelectedIntoView() {
    await tick();
    const el = listEl?.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }

  function moveSelection(delta: number) {
    if (results.length === 0) return;
    selectedIndex =
      (selectedIndex + delta + results.length) % results.length;
    void scrollSelectedIntoView();
  }

  async function openSelected() {
    const selected = results[selectedIndex];
    if (!selected) return;
    onClose();
    try {
      await project.openTab(selected.item.path);
    } catch (err) {
      notify.error(
        `Couldn't open ${selected.item.path}: ${formatError(err)}`,
        err,
      );
    }
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void openSelected();
    }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  // Split a display string into alternating plain / highlighted runs
  // driven by the fuzzy scorer's matched indices. Used so matched chars
  // render boldly in the list. `indices` must be strictly increasing,
  // which the scorer guarantees.
  function splitHighlight(
    text: string,
    indices: number[],
  ): { text: string; hit: boolean }[] {
    if (indices.length === 0) return [{ text, hit: false }];
    const parts: { text: string; hit: boolean }[] = [];
    let cursor = 0;
    for (const i of indices) {
      if (i > cursor) {
        parts.push({ text: text.slice(cursor, i), hit: false });
      }
      parts.push({ text: text[i] ?? "", hit: true });
      cursor = i + 1;
    }
    if (cursor < text.length) {
      parts.push({ text: text.slice(cursor), hit: false });
    }
    return parts;
  }

  // Split a full file path into its dirname (grey) and basename (fg)
  // halves so the UI can render them with different weights while
  // preserving the matched-char highlights across the split.
  function renderRow(path: string, indices: number[]) {
    const lastSep = path.lastIndexOf("/");
    if (lastSep === -1) {
      return {
        dir: [] as { text: string; hit: boolean }[],
        name: splitHighlight(path, indices),
      };
    }
    const dirIndices = indices.filter((i) => i < lastSep);
    const nameIndices = indices
      .filter((i) => i > lastSep)
      .map((i) => i - lastSep - 1);
    return {
      dir: splitHighlight(path.slice(0, lastSep) + "/", dirIndices),
      name: splitHighlight(path.slice(lastSep + 1), nameIndices),
    };
  }
</script>

<div class="backdrop" onmousedown={handleBackdrop} role="presentation">
  <div
    class="palette"
    role="dialog"
    aria-label="Open file"
    aria-modal="true"
  >
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={inputEl}
      type="text"
      class="query"
      placeholder="Open file by name…"
      bind:value={query}
      onkeydown={handleKey}
      autofocus
    />
    <div bind:this={listEl} class="results" role="listbox">
      {#if results.length === 0}
        <p class="empty">
          {query.trim().length === 0
            ? "No recent files yet — start typing to search."
            : "No matches."}
        </p>
      {:else}
        {#each results as entry, i (entry.item.path)}
          {@const row = renderRow(entry.item.path, entry.indices)}
          <button
            type="button"
            class="row"
            class:selected={i === selectedIndex}
            data-index={i}
            role="option"
            aria-selected={i === selectedIndex}
            onmouseenter={() => {
              selectedIndex = i;
            }}
            onclick={() => openSelected()}
          >
            <span class="row-name">
              {#each row.name as part}
                {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
              {/each}
            </span>
            {#if row.dir.length > 0}
              <span class="row-dir">
                {#each row.dir as part}
                  {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 150;
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  }

  .palette {
    background: var(--skrive-bg);
    border: 2px solid var(--skrive-fg);
    width: 36rem;
    max-width: calc(100vw - 2rem);
    display: flex;
    flex-direction: column;
    max-height: 60vh;
    min-height: 0;
  }

  .query {
    width: 100%;
    box-sizing: border-box;
    padding: 0.75rem 1rem;
    border: none;
    border-bottom: 1px solid var(--skrive-rule);
    background: transparent;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 0.9375rem;
  }

  .query:focus {
    outline: none;
  }

  .query::placeholder {
    color: var(--skrive-muted);
  }

  .results {
    overflow-y: auto;
    min-height: 0;
    padding: 0.25rem 0;
  }

  .empty {
    margin: 0;
    padding: 1rem;
    font-size: 0.8125rem;
    color: var(--skrive-muted);
    text-align: center;
  }

  .row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    padding: 0.375rem 1rem;
    background: transparent;
    border: none;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    cursor: pointer;
    gap: 0.125rem;
  }

  .row.selected {
    background: var(--skrive-rule);
  }

  .row-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .row-dir {
    font-size: 0.6875rem;
    color: var(--skrive-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  mark {
    background: transparent;
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
</style>
