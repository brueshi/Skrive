<script lang="ts">
  // ⌘⇧P command palette. Sibling of FileSwitcher (⌘P) — same modal
  // shell, same fuzzy ranker, same gesture vocabulary. The haystack
  // here is the command registry rather than the file manifest.
  //
  // Behavior:
  //   - Empty query: show every available command (those whose `when`
  //     predicate currently passes), grouped by `group`. Group order
  //     follows the registry's declaration order.
  //   - Typed query: fuzzy-score commands by label and show best-N
  //     flat (no group headers in filtered mode — the matched chars
  //     are the visual organizer).
  //   - ↑/↓ move the selection, Enter runs, Esc dismisses.
  //
  // The palette closes immediately on Enter and then awaits the
  // command's run promise, so long-running actions don't block the
  // dismiss animation. Errors surface through the existing toast
  // system; the palette stays out of the error path.

  import { tick } from "svelte";
  import { rankItems, type ScoredEntry } from "$lib/editor/fuzzy";
  import {
    buildCommands,
    type Command,
    type CommandDeps,
    type CommandGroup,
  } from "$lib/commands/registry";
  import { notify } from "$lib/stores/notifications.svelte";
  import { formatError } from "$lib/errors";

  type Props = {
    onClose: () => void;
    deps: CommandDeps;
  };

  let { onClose, deps }: Props = $props();

  let query = $state("");
  let selectedIndex = $state(0);
  let listEl: HTMLDivElement | null = $state(null);

  const MAX_FILTERED_RESULTS = 30;

  // Build the registry through `$derived` so Svelte tracks `deps`
  // properly (it's a prop, and a top-level `let cmds = buildCommands(deps)`
  // would only capture the mount-time value). `deps` is stable in
  // practice so this only fires once per palette open in real use —
  // the indirection is just for compiler hygiene.
  const allCommands = $derived<Command[]>(buildCommands(deps));

  const availableCommands = $derived.by<Command[]>(() =>
    allCommands.filter((c) => (c.when ? c.when() : true)),
  );

  type Row =
    | { kind: "header"; group: CommandGroup }
    | {
        kind: "command";
        command: Command;
        indices: number[];
      };

  // What the list renders. Empty query: grouped, with a header row per
  // group. Filtered: flat ranked list with no headers.
  const rows = $derived.by<Row[]>(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      const out: Row[] = [];
      let lastGroup: CommandGroup | null = null;
      for (const cmd of availableCommands) {
        if (cmd.group !== lastGroup) {
          out.push({ kind: "header", group: cmd.group });
          lastGroup = cmd.group;
        }
        out.push({ kind: "command", command: cmd, indices: [] });
      }
      return out;
    }
    const scored: ScoredEntry<Command>[] = rankItems(
      trimmed,
      availableCommands,
      (c) => c.label,
    );
    return scored
      .slice(0, MAX_FILTERED_RESULTS)
      .map((s) => ({
        kind: "command" as const,
        command: s.item,
        indices: s.indices,
      }));
  });

  // Indexes of just the command rows. Selection moves over command
  // rows only, so headers don't catch the cursor.
  const commandRowIndexes = $derived.by<number[]>(() => {
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]?.kind === "command") out.push(i);
    }
    return out;
  });

  $effect(() => {
    void query;
    selectedIndex = 0;
  });

  $effect(() => {
    if (selectedIndex >= commandRowIndexes.length) {
      selectedIndex = Math.max(0, commandRowIndexes.length - 1);
    }
  });

  async function scrollSelectedIntoView() {
    await tick();
    const rowIndex = commandRowIndexes[selectedIndex];
    if (rowIndex == null) return;
    const el = listEl?.querySelector<HTMLElement>(
      `[data-row-index="${rowIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }

  function moveSelection(delta: number) {
    if (commandRowIndexes.length === 0) return;
    selectedIndex =
      (selectedIndex + delta + commandRowIndexes.length) %
      commandRowIndexes.length;
    void scrollSelectedIntoView();
  }

  async function runSelected() {
    const rowIndex = commandRowIndexes[selectedIndex];
    if (rowIndex == null) return;
    const row = rows[rowIndex];
    if (!row || row.kind !== "command") return;
    const cmd = row.command;
    onClose();
    try {
      await cmd.run();
    } catch (err) {
      notify.error(
        `Couldn't run "${cmd.label}": ${formatError(err)}`,
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
      void runSelected();
    }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  // Highlight the matched chars in a command label, mirroring the
  // FileSwitcher's renderRow but for plain (non-path) strings.
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
</script>

<div class="backdrop" onmousedown={handleBackdrop} role="presentation">
  <div
    class="palette"
    role="dialog"
    aria-label="Run command"
    aria-modal="true"
  >
    <!-- svelte-ignore a11y_autofocus -->
    <input
      type="text"
      class="query"
      placeholder="Type a command…"
      bind:value={query}
      onkeydown={handleKey}
      autofocus
    />
    <div bind:this={listEl} class="results" role="listbox">
      {#if rows.length === 0}
        <p class="empty">No commands match.</p>
      {:else}
        {#each rows as row, i (row.kind === "header" ? `h:${row.group}` : `c:${row.command.id}`)}
          {#if row.kind === "header"}
            <div class="group-header">{row.group}</div>
          {:else}
            {@const isSelected =
              commandRowIndexes[selectedIndex] === i}
            {@const labelParts = splitHighlight(
              row.command.label,
              row.indices,
            )}
            <button
              type="button"
              class="row"
              class:selected={isSelected}
              data-row-index={i}
              role="option"
              aria-selected={isSelected}
              onmouseenter={() => {
                const idx = commandRowIndexes.indexOf(i);
                if (idx !== -1) selectedIndex = idx;
              }}
              onclick={() => runSelected()}
            >
              <span class="row-label">
                {#each labelParts as part}
                  {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
              {#if row.command.shortcut}
                <span class="row-shortcut">{row.command.shortcut}</span>
              {/if}
            </button>
          {/if}
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

  .group-header {
    padding: 0.5rem 1rem 0.25rem;
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--skrive-muted);
    font-weight: 600;
  }

  .group-header:first-child {
    padding-top: 0.25rem;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    padding: 0.4rem 1rem;
    background: transparent;
    border: none;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    cursor: pointer;
  }

  .row.selected {
    background: var(--skrive-rule);
  }

  .row-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .row-shortcut {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.6875rem;
    color: var(--skrive-muted);
    flex-shrink: 0;
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
