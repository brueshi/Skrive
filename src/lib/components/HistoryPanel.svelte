<script lang="ts">
  // Floating version-history list for the active tab. "What versions
  // exist of this file?" — one row per git commit or Skrive-managed
  // checkpoint, newest-first, same visual language as the other
  // top-right panels.
  //
  // The list data lives on the project store (`historyOfActive`) so
  // the header's HI · N indicator reads the same array without a
  // second round-trip. Refresh triggers live in +page.svelte — on tab
  // change and on watcher events — matching how backlinks refreshes.
  //
  // Click semantics (per docs/3.3-diff-ui-design.md):
  //   - Single click on a row = diff that version against the current
  //     file, and stash the row's id as the pair-compare baseline.
  //   - Shift-click while a baseline is stashed = pair-diff that
  //     baseline against the shift-clicked row.
  // Step 1.6 implements the layout-mode transition; for now the
  // store's `openDiffForEntry` is a stub that just clears the anchor.
  //
  // Shares the top-right anchor zone with frontmatter, personal
  // dictionary, and backlinks. Opening this one closes those three so
  // they never overlap visually.

  import { project } from "$lib/stores/project.svelte";
  import { preferences } from "$lib/stores/preferences.svelte";
  import type { HistoryEntry } from "$lib/types";

  let panelRoot: HTMLDivElement | undefined = $state();

  const activePath = $derived(project.activeTab?.path ?? "");
  const rows = $derived(project.historyOfActive);
  const mode = $derived(project.historyMode);
  const baseId = $derived(project.historyPairBaseId);
  // Diff entry is disabled from split mode — the two-pane surface is
  // already in use. The panel still lists history, but rows are
  // inert and a notice at the top of the body explains why.
  const splitBlocksDiff = $derived(project.activeTab?.layoutMode === "split");

  // Mutual exclusion with the other three floating panels that share
  // this anchor zone. Last-opened wins, matching the existing pattern.
  $effect(() => {
    if (project.historyPanelOpen) {
      if (project.frontmatterPanelOpen) project.closeFrontmatterPanel();
      if (project.backlinksPanelOpen) project.closeBacklinksPanel();
      if (preferences.dictionaryPanelOpen) preferences.closeDictionaryPanel();
    }
  });

  function entryId(entry: HistoryEntry): string {
    return entry.source === "git" ? entry.sha : entry.id;
  }

  function entryKey(entry: HistoryEntry): string {
    return `${entry.source}:${entryId(entry)}`;
  }

  function entryTimestamp(entry: HistoryEntry): number {
    return entry.timestampMs;
  }

  function entryPrimary(entry: HistoryEntry): string {
    if (entry.source === "git") return entry.subject || "(no subject)";
    if (entry.name) return entry.name;
    if (entry.kind === "manual") return "(pinned)";
    return "Autosave";
  }

  function entryMeta(entry: HistoryEntry): string {
    if (entry.source === "git") {
      return entry.shortSha;
    }
    return entry.kind === "manual" ? "manual" : "auto";
  }

  function isoTooltip(entry: HistoryEntry): string {
    const iso = new Date(entry.timestampMs).toISOString();
    if (entry.source === "git") {
      const author = entry.authorName ? ` — ${entry.authorName}` : "";
      return `${iso}${author}\n${entry.sha}`;
    }
    return iso;
  }

  // Human-friendly relative time. Keeps the vocabulary short on purpose
  // — the row is narrow and a precise time lives in the title tooltip.
  function relativeTime(tsMs: number, nowMs: number): string {
    const delta = nowMs - tsMs;
    if (delta < 0) return "just now";
    const seconds = Math.floor(delta / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks} wk${weeks === 1 ? "" : "s"} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} mo ago`;
    const years = Math.floor(days / 365);
    return `${years} yr${years === 1 ? "" : "s"} ago`;
  }

  // `now` is re-sampled every minute so "N min ago" rows self-update
  // without needing the user to close and re-open the panel. Only
  // ticks while the panel is open to stay out of the way otherwise.
  let now = $state(Date.now());
  $effect(() => {
    if (!project.historyPanelOpen) return;
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 60_000);
    return () => clearInterval(timer);
  });

  function handleRowClick(entry: HistoryEntry, event: MouseEvent) {
    if (splitBlocksDiff) return;
    const id = entryId(entry);
    if (event.shiftKey && baseId && baseId !== id) {
      const baseline =
        rows.find((r) => entryId(r) === baseId) ?? null;
      void project.openDiffForEntry(entry, baseline);
      return;
    }
    // Single click: stash as the pair-compare anchor AND enter diff.
    // Stashing before the call means a follow-up shift-click still has
    // the right baseline even if the entry flow clears state.
    project.setHistoryPairBaseId(id);
    void project.openDiffForEntry(entry, null);
  }

  function handleRowKeydown(e: KeyboardEvent, entry: HistoryEntry) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // Keyboard activation always goes through the "compare vs current"
      // single-click path. Pair-compare is mouse-only for now — adding
      // a keyboard modifier is easy, but nobody's asked for it yet.
      handleRowClick(entry, new MouseEvent("click"));
    }
  }

  function handleRootKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      project.closeHistoryPanel();
    }
  }

  // Click-outside dismissal. Mirrors the other panels' pattern,
  // including the data-panel-toggle escape hatch so clicking the header
  // toggle closes the panel cleanly instead of firing close-then-open.
  $effect(() => {
    if (!project.historyPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (!panelRoot) return;
      const target = e.target as Node | null;
      if (target && !panelRoot.contains(target)) {
        const hit = (target as Element | null)?.closest?.(
          '[data-panel-toggle="history"]',
        );
        if (hit) return;
        project.closeHistoryPanel();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  });
</script>

<div
  class="hi-panel-wrapper"
  class:hi-panel-open={project.historyPanelOpen}
  aria-hidden={!project.historyPanelOpen}
>
  <div
    class="hi-panel"
    bind:this={panelRoot}
    role="dialog"
    tabindex="-1"
    aria-label="Version history"
    onkeydown={handleRootKeydown}
  >
    <header class="hi-panel-header">
      <span class="hi-panel-title">History</span>
      <span class="hi-panel-target" title={activePath}>{activePath}</span>
      {#if mode}
        <span class="hi-panel-mode" title={mode === "git" ? "Backed by git" : "Backed by Skrive checkpoints"}
          >{mode === "git" ? "git" : "checkpoints"}</span
        >
      {/if}
      <span class="hi-panel-count">{rows.length}</span>
    </header>

    <div class="hi-panel-body">
      {#if splitBlocksDiff}
        <p class="hi-notice">
          Switch to raw or preview to compare versions — split mode uses
          the two-pane surface diff needs.
        </p>
      {/if}
      {#if !mode}
        <p class="hi-empty">Open a project to view its history.</p>
      {:else if rows.length === 0}
        <p class="hi-empty">
          {#if mode === "git"}
            No commits touch this file yet.
          {:else}
            No checkpoints yet — Skrive writes one every few minutes of
            editing, or you can pin a version from here.
          {/if}
        </p>
      {:else}
        <ul class="hi-rows">
          {#each rows as row (entryKey(row))}
            {@const id = entryId(row)}
            {@const pinned = id === baseId}
            <li class="hi-row">
              <button
                type="button"
                class="hi-row-button"
                class:hi-row-pinned={pinned}
                disabled={splitBlocksDiff}
                onclick={(e) => handleRowClick(row, e)}
                onkeydown={(e) => handleRowKeydown(e, row)}
                title={isoTooltip(row)}
              >
                <span class="hi-row-line-1">
                  <span class="hi-row-primary">{entryPrimary(row)}</span>
                  {#if pinned}
                    <span class="hi-row-anchor" aria-label="Baseline for shift-click compare">⇌</span>
                  {/if}
                </span>
                <span class="hi-row-line-2">
                  <span class="hi-row-meta">{entryMeta(row)}</span>
                  <span class="hi-row-time">{relativeTime(entryTimestamp(row), now)}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</div>

<style>
  .hi-panel-wrapper {
    position: absolute;
    top: 48px;
    right: 12px;
    width: 26rem;
    max-width: calc(100vw - 24px);
    z-index: 100;

    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 180ms cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: none;
  }

  .hi-panel-wrapper.hi-panel-open {
    grid-template-rows: 1fr;
    pointer-events: auto;
  }

  .hi-panel {
    overflow: hidden;
    background: var(--skrive-bg);
    border: 1px solid var(--skrive-fg);
    border-radius: 4px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
    opacity: 0;
    transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
    max-height: 50vh;
    display: flex;
    flex-direction: column;
  }

  .hi-panel-wrapper.hi-panel-open .hi-panel {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .hi-panel-wrapper,
    .hi-panel {
      transition: none;
    }
  }

  .hi-panel-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--skrive-rule);
    flex-shrink: 0;
    background: var(--skrive-bg);
  }

  .hi-panel-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    color: var(--skrive-fg);
    flex-shrink: 0;
  }

  .hi-panel-target {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .hi-panel-mode {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--skrive-muted);
    border: 1px solid var(--skrive-rule);
    border-radius: 3px;
    padding: 0 0.35rem;
    flex-shrink: 0;
  }

  .hi-panel-count {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    flex-shrink: 0;
  }

  .hi-panel-body {
    padding: 0.25rem 0;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    font-size: 13px;
  }

  .hi-empty {
    margin: 0;
    padding: 0.5rem 0.875rem 0.75rem;
    font-size: 12px;
    color: var(--skrive-muted);
    line-height: 1.5;
  }

  /* "Can't compare from split" notice. Sits at the top of the body so
     it reads before the (now-inert) row list — the user learns why
     their clicks aren't doing anything before they try. */
  .hi-notice {
    margin: 0;
    padding: 0.55rem 0.875rem;
    font-size: 12px;
    color: var(--skrive-muted);
    background: var(--skrive-rule);
    border-bottom: 1px solid var(--skrive-rule);
    line-height: 1.45;
  }

  .hi-rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .hi-row + .hi-row {
    border-top: 1px dashed var(--skrive-rule);
  }

  .hi-row-button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    background: transparent;
    border: none;
    padding: 0.45rem 0.875rem;
    font: inherit;
    color: var(--skrive-fg);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .hi-row-button:hover,
  .hi-row-button:focus-visible {
    background: var(--skrive-rule);
    outline: none;
  }

  .hi-row-button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .hi-row-button:disabled:hover {
    background: transparent;
  }

  .hi-row-button.hi-row-pinned {
    background: var(--skrive-rule);
  }

  .hi-row-line-1 {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    overflow: hidden;
  }

  .hi-row-primary {
    font-size: 13px;
    color: var(--skrive-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .hi-row-anchor {
    font-size: 11px;
    color: var(--skrive-muted);
    flex-shrink: 0;
  }

  .hi-row-line-2 {
    display: inline-flex;
    align-items: baseline;
    gap: 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    width: 100%;
    overflow: hidden;
  }

  .hi-row-meta {
    flex-shrink: 0;
  }

  .hi-row-time {
    flex-shrink: 0;
    opacity: 0.85;
  }
</style>
