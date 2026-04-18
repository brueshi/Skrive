<script lang="ts">
  // ⌘⇧F project-wide text search.
  //
  // Same visual weight as CommandPalette but wider — snippets need room
  // to breathe. Results are grouped by file; each hit shows the line
  // number and the matched span inline with surrounding context. Enter
  // jumps to the selected hit via the project store's open-at-line path.
  //
  // The search itself runs in Rust (`search_project`). We debounce the
  // invoke so typing doesn't fan out IPC round-trips.

  import { invoke } from "@tauri-apps/api/core";
  import { project } from "$lib/stores/project.svelte";
  import type { SearchHit } from "$lib/types";
  import { formatError } from "$lib/errors";

  type Props = {
    onClose: () => void;
  };

  let { onClose }: Props = $props();

  const DEBOUNCE_MS = 150;

  let query = $state("");
  let caseSensitive = $state(false);
  let hits = $state<SearchHit[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let selectedIndex = $state(0);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic token guards against out-of-order responses: if the user
  // types fast, an earlier invoke may resolve after a later one — we
  // discard any result whose token doesn't match the latest issued.
  let searchToken = 0;

  let listEl: HTMLDivElement | null = $state(null);

  // Group hits by file, preserving the path-sorted order from Rust so
  // group navigation is stable.
  const grouped = $derived.by<{ path: string; items: SearchHit[] }[]>(() => {
    const groups: { path: string; items: SearchHit[] }[] = [];
    let current: { path: string; items: SearchHit[] } | null = null;
    for (const hit of hits) {
      if (!current || current.path !== hit.path) {
        current = { path: hit.path, items: [hit] };
        groups.push(current);
      } else {
        current.items.push(hit);
      }
    }
    return groups;
  });

  // Run the search when query or case-sensitivity changes. Debounced so
  // a fast typist doesn't fire a dozen invokes.
  $effect(() => {
    const q = query.trim();
    const cs = caseSensitive;

    if (debounceTimer) clearTimeout(debounceTimer);

    if (q.length === 0) {
      hits = [];
      loading = false;
      error = null;
      return;
    }

    loading = true;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSearch(q, cs);
    }, DEBOUNCE_MS);
  });

  async function runSearch(q: string, cs: boolean) {
    searchToken += 1;
    const token = searchToken;
    try {
      const result = await invoke<SearchHit[]>("search_project", {
        query: q,
        options: { caseSensitive: cs },
      });
      if (token !== searchToken) return; // stale
      hits = result;
      selectedIndex = 0;
      error = null;
    } catch (e) {
      if (token !== searchToken) return;
      hits = [];
      error = formatError(e);
    } finally {
      if (token === searchToken) loading = false;
    }
  }

  async function scrollSelectedIntoView() {
    const el = listEl?.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }

  function moveSelection(delta: number) {
    if (hits.length === 0) return;
    selectedIndex = (selectedIndex + delta + hits.length) % hits.length;
    void scrollSelectedIntoView();
  }

  async function openSelected() {
    const hit = hits[selectedIndex];
    if (!hit) return;
    onClose();
    try {
      await project.openTabAtLine(
        hit.path,
        hit.lineNumber,
        hit.column,
        hit.matchLength,
      );
    } catch (err) {
      console.error("Failed to open file at line:", hit, err);
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

  // Split a snippet around the match into before / match / after runs so
  // the row can highlight the matched span without re-implementing the
  // index math in template land. `column` is a char offset into the
  // snippet, which maps cleanly to JS String#slice for ASCII content
  // (the dogfood case). TODO: switch to UTF-16 offsets for accurate
  // highlighting on non-ASCII content.
  function splitSnippet(hit: SearchHit): {
    before: string;
    matched: string;
    after: string;
  } {
    const start = Math.max(0, hit.column);
    const end = Math.min(hit.snippet.length, start + hit.matchLength);
    return {
      before: hit.snippet.slice(0, start),
      matched: hit.snippet.slice(start, end),
      after: hit.snippet.slice(end),
    };
  }

  // Running flat index across the grouped view — each hit row knows
  // which slot in the flat `hits` array it maps to. Rebuild from groups
  // so we don't have to thread indices through the nested each blocks.
  function flatIndex(groupIdx: number, hitIdx: number): number {
    let n = hitIdx;
    for (let i = 0; i < groupIdx; i++) {
      n += grouped[i]?.items.length ?? 0;
    }
    return n;
  }
</script>

<div class="backdrop" onmousedown={handleBackdrop} role="presentation">
  <div class="palette" role="dialog" aria-label="Search" aria-modal="true">
    <div class="query-row">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        class="query"
        placeholder="Search project…"
        bind:value={query}
        onkeydown={handleKey}
        autofocus
      />
      <label class="case-toggle" title="Match case">
        <input type="checkbox" bind:checked={caseSensitive} />
        <span>Aa</span>
      </label>
    </div>

    <div class="status">
      {#if loading}
        <span>Searching…</span>
      {:else if error}
        <span class="err">{error}</span>
      {:else if query.trim().length === 0}
        <span>Type to search file contents.</span>
      {:else if hits.length === 0}
        <span>No matches.</span>
      {:else}
        <span>
          {hits.length}
          {hits.length === 1 ? "match" : "matches"} in {grouped.length}
          {grouped.length === 1 ? "file" : "files"}
        </span>
      {/if}
    </div>

    <div bind:this={listEl} class="results" role="listbox">
      {#each grouped as group, gi (group.path)}
        <div class="group-header">
          <span class="group-path">{group.path}</span>
          <span class="group-count">{group.items.length}</span>
        </div>
        {#each group.items as hit, hi (hit.lineNumber + ":" + hit.column)}
          {@const idx = flatIndex(gi, hi)}
          {@const parts = splitSnippet(hit)}
          <button
            type="button"
            class="hit"
            class:selected={idx === selectedIndex}
            data-index={idx}
            role="option"
            aria-selected={idx === selectedIndex}
            onmouseenter={() => {
              selectedIndex = idx;
            }}
            onclick={() => openSelected()}
          >
            <span class="line-no">{hit.lineNumber}</span>
            <span class="snippet">
              <span class="ctx">{parts.before}</span><mark>{parts.matched}</mark><span
                class="ctx">{parts.after}</span
              >
            </span>
          </button>
        {/each}
      {/each}
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
    padding-top: 10vh;
    z-index: 150;
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  }

  .palette {
    background: var(--skrive-bg);
    border: 2px solid var(--skrive-fg);
    width: 48rem;
    max-width: calc(100vw - 2rem);
    display: flex;
    flex-direction: column;
    max-height: 70vh;
    min-height: 0;
  }

  .query-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem 0.5rem 1rem;
    border-bottom: 1px solid var(--skrive-rule);
  }

  .query {
    flex: 1;
    padding: 0.25rem 0;
    border: none;
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

  .case-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.375rem;
    font-size: 0.75rem;
    color: var(--skrive-muted);
    cursor: pointer;
    user-select: none;
    border: 1px solid transparent;
    border-radius: 3px;
  }

  .case-toggle:hover {
    border-color: var(--skrive-rule);
  }

  .case-toggle input {
    accent-color: var(--skrive-fg);
  }

  .status {
    padding: 0.375rem 1rem;
    font-size: 0.75rem;
    color: var(--skrive-muted);
    border-bottom: 1px solid var(--skrive-rule);
  }

  .status .err {
    color: #a84030;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .results {
    overflow-y: auto;
    min-height: 0;
  }

  .group-header {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 1rem 0.25rem;
    background: var(--skrive-bg);
    color: var(--skrive-fg);
    font-size: 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    border-bottom: 1px solid var(--skrive-rule);
  }

  .group-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .group-count {
    flex-shrink: 0;
    margin-left: 0.75rem;
    color: var(--skrive-muted);
  }

  .hit {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    width: 100%;
    padding: 0.25rem 1rem;
    background: transparent;
    border: none;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    cursor: pointer;
  }

  .hit.selected {
    background: var(--skrive-rule);
  }

  .line-no {
    flex-shrink: 0;
    width: 3em;
    color: var(--skrive-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    text-align: right;
  }

  .snippet {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .snippet .ctx {
    color: var(--skrive-fg);
  }

  mark {
    background: var(--skrive-selection);
    color: inherit;
    font-weight: 600;
    padding: 0 1px;
  }
</style>
