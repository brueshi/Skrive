<script lang="ts">
  // Floating frontmatter editor for the active tab.
  //
  // The panel is an *orthogonal tool*, not pinned chrome — it's invoked via
  // the FM · N indicator in the header or the ⌘⇧F shortcut, and dismissed
  // via Escape, a click outside, or the same toggle. When closed, the only
  // visible cost is the header indicator; when open, the panel floats in
  // the top-right of the workspace with no impact on the editor surface's
  // available vertical space.
  //
  // Per-type rendering:
  //
  //   - string, number, null, new fields  → plain text input
  //   - boolean                           → text input, coerces "true"/"false"
  //                                          back to bool on commit
  //   - array                             → FrontmatterChipInput
  //   - object                            → read-only `<object>` placeholder
  //
  // Commit contract: on blur or Enter, each input re-parses the current
  // text using the *original value type as a hint* so typing `false` into
  // a boolean field stays a boolean rather than silently becoming a string.
  // New fields default to string because there's no way to disambiguate
  // intent from text alone.
  //
  // Key rename conflict: the store's `renameActiveTabFrontmatterKey` action
  // silently no-ops when the target key already exists. The panel re-reads
  // the map after the rename attempt, so a no-op naturally shows the old
  // key in the UI with no modal needed.
  //
  // Animation: open/close uses `grid-template-rows: 0fr → 1fr` plus an
  // opacity fade on the inner content, 180ms on the mechanical ease curve.
  // `prefers-reduced-motion` reduces the transition to zero.

  import { project } from "$lib/stores/project.svelte";
  import FrontmatterChipInput from "./FrontmatterChipInput.svelte";

  // ============================ Local state ============================
  //
  // The panel maintains its own `rows` list with stable per-row IDs, rather
  // than iterating `Object.keys(frontmatter)` directly. This matters because
  // renaming a field translates to `delete oldKey + assign newKey` on the
  // frontmatter map; if the `#each` block were keyed by the field's *key*,
  // Svelte would unmount the old row and mount a new one on every rename.
  // That unmount/remount is what used to break `Tab` navigation from key
  // input to value input (the value input would be torn down mid-Tab) and
  // caused rows to visually jump on commit.
  //
  // With row IDs as the `#each` identity, renames update `row.key` in place,
  // the DOM element is reused, focus stays put, and Tab navigates naturally
  // to the next focusable element in the row. Values are still read from
  // the store via `row.key` on every render, so auto-stamped updates from
  // the save path (e.g. `last_modified`) still flow through.

  type Row = { id: string; key: string };

  let panelRoot: HTMLDivElement | undefined = $state();

  let activeTab = $derived(project.activeTab);
  let activeFrontmatter = $derived(
    activeTab?.content.frontmatter ?? ({} as Record<string, unknown>),
  );

  let rows = $state<Row[]>([]);
  let nextRowId = 0;
  let lastSyncedPath: string | null = null;

  function makeRow(key: string): Row {
    const id = String(nextRowId);
    nextRowId += 1;
    return { id, key };
  }

  // Sync `rows` from the store's active-tab frontmatter whenever the
  // user switches to a different file. While the panel is focused on a
  // single file, local `rows` is the source of truth for row identity —
  // commits go both to the store and to `rows` so the two stay in sync
  // without needing to re-derive from `Object.keys` on every change.
  $effect(() => {
    const path = activeTab?.path ?? null;
    if (path === lastSyncedPath) return;
    lastSyncedPath = path;
    rows = Object.keys(activeFrontmatter).map(makeRow);
  });

  // ============================ Helpers ============================

  function valueTypeOf(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    if (typeof value === "string") return "string";
    if (Array.isArray(value)) return "array";
    if (typeof value === "object") return "object";
    return "string";
  }

  /**
   * Coerce a text input back to the original value type. Used when a
   * plain-text editor commits a new value for a field that was typed as
   * boolean / number / null so we don't silently change the underlying
   * YAML type. Unknown conversions fall back to a string so the user's
   * text is never dropped.
   */
  function coerceToOriginalType(
    text: string,
    originalType: string,
  ): unknown {
    if (originalType === "boolean") {
      if (text === "true") return true;
      if (text === "false") return false;
      // User typed something that isn't a bool literal — explicitly flipping
      // the field's type is their call, keep it as a string.
      return text;
    }
    if (originalType === "number") {
      if (text.trim() === "") return text;
      const n = Number(text);
      if (Number.isFinite(n) && text.trim() !== "") return n;
      return text;
    }
    if (originalType === "null") {
      // Any non-empty edit turns a null field into a string.
      return text.length === 0 ? null : text;
    }
    // string, object placeholder, array-turned-string, and new fields.
    return text;
  }

  /**
   * Stringify a value for display in a text input. Arrays are handled by
   * the chip component instead — this helper is only called for the
   * single-line text inputs.
   */
  function stringifyValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    return ""; // objects and arrays — shouldn't reach here
  }

  // ============================ Mutation actions ============================

  function commitValue(row: Row, nextText: string, originalType: string) {
    const coerced = coerceToOriginalType(nextText, originalType);
    project.updateActiveTabFrontmatter(row.key, coerced);
  }

  function commitArrayValue(row: Row, nextArray: string[]) {
    project.updateActiveTabFrontmatter(row.key, nextArray);
  }

  function removeField(row: Row) {
    project.removeActiveTabFrontmatter(row.key);
    rows = rows.filter((r) => r.id !== row.id);
  }

  /**
   * Called on a key input's blur. If the user typed a new key, rename the
   * field in place. Empty keys discard the row. Conflicts (duplicate key
   * within the same file) silently revert by imperatively resetting the
   * input's value, because a one-way `value={row.key}` binding won't
   * re-push the old value when the underlying state is unchanged.
   */
  function commitKey(
    row: Row,
    newKey: string,
    inputEl: HTMLInputElement,
  ) {
    const trimmed = newKey.trim();
    if (trimmed === row.key) return;
    if (trimmed.length === 0) {
      // Empty key → discard the row entirely.
      removeField(row);
      return;
    }
    const conflict = rows.some((r) => r.id !== row.id && r.key === trimmed);
    if (conflict) {
      // Revert — force the input back to the previous key. No modal, no
      // error; the plan's explicit "silently revert on conflict" rule.
      inputEl.value = row.key;
      return;
    }
    project.renameActiveTabFrontmatterKey(row.key, trimmed);
    row.key = trimmed;
  }

  function addNewField() {
    // Find a non-conflicting temporary key. Users are expected to rename
    // it immediately; the temporary name just gives us a slot in the map.
    let base = "new_field";
    let candidate = base;
    let i = 2;
    while (
      rows.some((r) => r.key === candidate) ||
      candidate in activeFrontmatter
    ) {
      candidate = `${base}_${i}`;
      i += 1;
    }
    project.updateActiveTabFrontmatter(candidate, "");
    const row = makeRow(candidate);
    rows = [...rows, row];
    // Focus the new key input on the next microtask so the DOM is rendered.
    queueMicrotask(() => {
      const input = panelRoot?.querySelector<HTMLInputElement>(
        `[data-row-id="${row.id}"] .key-input`,
      );
      input?.focus();
      input?.select();
    });
  }

  // ============================ Dismiss handling ============================

  function handleRootKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      project.closeFrontmatterPanel();
    }
  }

  // Click-outside dismissal. Listens at the document level while the
  // panel is open, removes itself when the panel closes.
  $effect(() => {
    if (!project.frontmatterPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (!panelRoot) return;
      const target = e.target as Node | null;
      if (target && !panelRoot.contains(target)) {
        // Also ignore clicks on the header indicator itself — clicking it
        // toggles via its own handler, and we don't want both handlers to
        // fire and re-open the panel we just closed.
        const hit = (target as Element | null)?.closest?.(".fm-indicator");
        if (hit) return;
        project.closeFrontmatterPanel();
      }
    };
    // Attach on the next tick so the click that opened the panel doesn't
    // immediately close it.
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  });

  // Relative path used in the panel header for "which file is this?".
  let activePathLabel = $derived(activeTab?.path ?? "");
</script>

<div
  class="fm-panel-wrapper"
  class:fm-panel-open={project.frontmatterPanelOpen}
  aria-hidden={!project.frontmatterPanelOpen}
>
  <div
    class="fm-panel"
    bind:this={panelRoot}
    role="dialog"
    tabindex="-1"
    aria-label="Frontmatter editor"
    onkeydown={handleRootKeydown}
  >
    <header class="fm-panel-header">
      <span class="fm-panel-title">Frontmatter</span>
      <span class="fm-panel-path" title={activePathLabel}>{activePathLabel}</span>
    </header>

    <div class="fm-panel-body">
      {#if rows.length === 0}
        <p class="fm-empty">
          No frontmatter yet. Add a field to start structured metadata for
          this file.
        </p>
      {/if}

      {#each rows as row (row.id)}
        {@const value = activeFrontmatter[row.key]}
        {@const type = valueTypeOf(value)}
        <div class="fm-row" data-row-id={row.id}>
          <input
            class="key-input"
            type="text"
            value={row.key}
            aria-label="Field key"
            onblur={(e) =>
              commitKey(row, e.currentTarget.value, e.currentTarget)}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                // Enter commits the rename (via blur) and hands focus to
                // the value input inside the same row so the user can keep
                // typing without reaching for the mouse.
                e.preventDefault();
                const rowEl = (e.currentTarget as HTMLInputElement).closest(
                  ".fm-row",
                );
                const valueInput = rowEl?.querySelector<HTMLElement>(
                  ".value-input, .chip-pending",
                );
                (e.currentTarget as HTMLInputElement).blur();
                valueInput?.focus();
              }
            }}
          />

          <div class="value-slot">
            {#if type === "array"}
              <FrontmatterChipInput
                value={(value as unknown[]).map((v) => String(v))}
                onChange={(next) => commitArrayValue(row, next)}
              />
            {:else if type === "object"}
              <span class="value-object" title="Nested object — edit via file">
                &lt;object&gt;
              </span>
            {:else}
              <input
                class="value-input"
                type="text"
                value={stringifyValue(value)}
                aria-label="Field value"
                onblur={(e) =>
                  commitValue(row, e.currentTarget.value, type)}
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
              />
            {/if}
          </div>

          <button
            type="button"
            class="remove-button"
            aria-label={`Remove ${row.key}`}
            title="Remove field"
            onclick={() => removeField(row)}
          >
            ×
          </button>
        </div>
      {/each}

      <button type="button" class="add-button" onclick={addNewField}>
        + Add field
      </button>
    </div>
  </div>
</div>

<style>
  /* Outer wrapper handles the grid-template-rows open/close animation.
     Inner `.fm-panel` is the actual floating surface. Splitting them
     lets us animate the height against auto-sized content while keeping
     the visual surface's styles (border, shadow, background) pinned to
     a single element. */
  .fm-panel-wrapper {
    position: absolute;
    top: 48px; /* just below the header (40px header + 8px gap) */
    right: 12px;
    width: 32rem;
    max-width: calc(100vw - 24px);
    z-index: 100;

    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 180ms cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: none;
  }

  .fm-panel-wrapper.fm-panel-open {
    grid-template-rows: 1fr;
    pointer-events: auto;
  }

  .fm-panel {
    overflow: hidden;
    background: var(--skrive-bg);
    border: 1px solid var(--skrive-fg);
    border-radius: 4px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
    opacity: 0;
    transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
    max-height: 40vh;
    display: flex;
    flex-direction: column;
  }

  .fm-panel-wrapper.fm-panel-open .fm-panel {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .fm-panel-wrapper,
    .fm-panel {
      transition: none;
    }
  }

  .fm-panel-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--skrive-rule);
    flex-shrink: 0;
    background: var(--skrive-bg);
  }

  .fm-panel-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    color: var(--skrive-fg);
  }

  .fm-panel-path {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    max-width: 20rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fm-panel-body {
    padding: 0.625rem 0.875rem;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    font-size: 13px;
  }

  .fm-empty {
    margin: 0 0 0.75rem;
    font-size: 12px;
    color: var(--skrive-muted);
    line-height: 1.5;
  }

  .fm-row {
    display: grid;
    grid-template-columns: 9rem 1fr auto;
    gap: 0.5rem;
    align-items: center;
    padding: 0.25rem 0;
  }

  .fm-row + .fm-row {
    border-top: 1px dashed var(--skrive-rule);
  }

  .key-input,
  .value-input {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 12px;
    padding: 0.3rem 0.4rem;
    width: 100%;
    box-sizing: border-box;
    outline: none;
    transition:
      border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .key-input {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--skrive-muted);
  }

  .key-input:hover,
  .value-input:hover {
    border-color: var(--skrive-rule);
  }

  .key-input:focus,
  .value-input:focus {
    border-color: var(--skrive-fg);
    color: var(--skrive-fg);
  }

  .value-slot {
    min-width: 0;
  }

  .value-object {
    display: inline-block;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    padding: 0.3rem 0.4rem;
    font-style: italic;
  }

  .remove-button {
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
    font-size: 14px;
    line-height: 1;
    border-radius: 3px;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .remove-button:hover {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  .add-button {
    background: transparent;
    border: 1px dashed var(--skrive-rule);
    border-radius: 3px;
    color: var(--skrive-muted);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    padding: 0.375rem 0.625rem;
    margin-top: 0.5rem;
    width: 100%;
    text-align: center;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .add-button:hover {
    color: var(--skrive-fg);
    border-color: var(--skrive-fg);
  }
</style>
