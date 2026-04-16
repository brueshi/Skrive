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
  import type { FieldInfo } from "$lib/types";
  import FrontmatterChipInput from "./FrontmatterChipInput.svelte";
  import SuggestionList from "./SuggestionList.svelte";

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

  // ============================ Autocomplete state ============================
  //
  // At most one suggestion dropdown can be open at a time — only one input
  // is focused. We track which row + which field (key vs. value) the
  // dropdown is anchored to, the filtered candidate list, and the selected
  // index. The dropdown is anchored inline below the focused input via
  // CSS, so positioning needs nothing here — only state and keyboard wiring.

  type SuggestionKind = "key" | "value";

  type ActiveSuggestion = {
    rowId: string;
    kind: SuggestionKind;
    suggestions: string[];
    selectedIndex: number;
  };

  let activeSuggestion = $state<ActiveSuggestion | null>(null);

  const SUGGESTION_LIMIT = 8;

  function lowerStartsWith(haystack: string, needle: string): boolean {
    if (needle.length === 0) return true;
    return haystack.toLowerCase().startsWith(needle.toLowerCase());
  }

  /**
   * Schema-driven candidates for a key input. Excludes field names already
   * present on this file (except the row's own current key, since that's
   * the field being edited and excluding it would prevent re-confirming
   * it as a valid choice). Ranked by descending presence so the field a
   * user is most likely to want appears first; alphabetical as tiebreaker.
   */
  function computeKeyCandidates(row: Row, prefix: string): string[] {
    const schema = project.schema;
    if (!schema) return [];
    const usedKeys = new Set(rows.map((r) => r.key));
    const candidates: { name: string; presence: number }[] = [];
    for (const [name, info] of Object.entries(schema.fields)) {
      if (usedKeys.has(name) && name !== row.key) continue;
      if (!lowerStartsWith(name, prefix)) continue;
      candidates.push({ name, presence: info.presence });
    }
    candidates.sort((a, b) => {
      const diff = b.presence - a.presence;
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name);
    });
    return candidates.slice(0, SUGGESTION_LIMIT).map((c) => c.name);
  }

  /**
   * Schema-driven candidates for a value input. Reads `knownValues` for
   * the row's current key; only populated by the Rust schema inference
   * for fields whose values across the project are scalars and number
   * ≤ 20 distinct. Returns empty for arrays, objects, large value sets,
   * or fields that don't exist in the schema.
   */
  function computeValueCandidates(row: Row, prefix: string): string[] {
    const schema = project.schema;
    if (!schema) return [];
    const info: FieldInfo | undefined = schema.fields[row.key];
    if (!info || info.knownValues.length === 0) return [];
    const out: string[] = [];
    for (const v of info.knownValues) {
      if (
        v !== null &&
        typeof v !== "string" &&
        typeof v !== "number" &&
        typeof v !== "boolean"
      ) {
        continue;
      }
      const display = v === null ? "" : String(v);
      if (!lowerStartsWith(display, prefix)) continue;
      out.push(display);
      if (out.length >= SUGGESTION_LIMIT) break;
    }
    return out;
  }

  function openKeySuggestions(row: Row, currentText: string) {
    const suggestions = computeKeyCandidates(row, currentText);
    if (suggestions.length === 0) {
      activeSuggestion = null;
      return;
    }
    activeSuggestion = {
      rowId: row.id,
      kind: "key",
      suggestions,
      selectedIndex: 0,
    };
  }

  function openValueSuggestions(row: Row, currentText: string) {
    const suggestions = computeValueCandidates(row, currentText);
    if (suggestions.length === 0) {
      activeSuggestion = null;
      return;
    }
    activeSuggestion = {
      rowId: row.id,
      kind: "value",
      suggestions,
      selectedIndex: 0,
    };
  }

  function dismissSuggestions() {
    activeSuggestion = null;
  }

  function navigateSuggestion(delta: number) {
    if (!activeSuggestion) return;
    const max = activeSuggestion.suggestions.length - 1;
    let next = activeSuggestion.selectedIndex + delta;
    if (next < 0) next = max;
    if (next > max) next = 0;
    activeSuggestion.selectedIndex = next;
  }

  function highlightSuggestion(index: number) {
    if (!activeSuggestion) return;
    activeSuggestion.selectedIndex = index;
  }

  function selectedSuggestion(): string | null {
    if (!activeSuggestion) return null;
    return activeSuggestion.suggestions[activeSuggestion.selectedIndex] ?? null;
  }

  function suggestionActiveFor(rowId: string, kind: SuggestionKind): boolean {
    return (
      activeSuggestion?.rowId === rowId && activeSuggestion?.kind === kind
    );
  }

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

  /**
   * Apply a chosen suggestion to its anchored input. For keys we route
   * through `commitKey` (which handles rename + conflict revert + empty-
   * key removal) and then jump focus to the value input on the same row.
   * For values we route through `commitValue` with the row's current
   * value type as the coercion hint.
   */
  function pickSuggestion(row: Row, value: string, inputEl: HTMLInputElement) {
    if (!activeSuggestion) return;
    const kind = activeSuggestion.kind;
    inputEl.value = value;
    if (kind === "key") {
      commitKey(row, value, inputEl);
      dismissSuggestions();
      const rowEl = inputEl.closest(".fm-row");
      const valueInput = rowEl?.querySelector<HTMLElement>(
        ".value-input, .chip-pending",
      );
      valueInput?.focus();
    } else {
      const currentValue = activeFrontmatter[row.key];
      const type = valueTypeOf(currentValue);
      commitValue(row, value, type);
      dismissSuggestions();
    }
  }

  /**
   * Keyboard handler shared by key and value inputs when a suggestion
   * dropdown is anchored to them. Returns `true` if the event was handled
   * (so the caller can skip its own default behavior). The four handled
   * keys map exactly to the spec: ↓/↑ navigate, Enter/Tab accept, Esc
   * dismisses the dropdown only — *not* the panel.
   */
  function handleSuggestionKeydown(
    e: KeyboardEvent,
    row: Row,
    kind: SuggestionKind,
  ): boolean {
    if (!suggestionActiveFor(row.id, kind)) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateSuggestion(1);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateSuggestion(-1);
      return true;
    }
    if (e.key === "Escape") {
      // Stop propagation so the panel root's Escape handler doesn't also
      // close the panel — Escape with a dropdown open should dismiss the
      // dropdown only, leaving the panel and the user's focus intact.
      e.preventDefault();
      e.stopPropagation();
      dismissSuggestions();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const picked = selectedSuggestion();
      if (picked !== null) {
        e.preventDefault();
        pickSuggestion(row, picked, e.currentTarget as HTMLInputElement);
        return true;
      }
    }
    return false;
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
          <div class="input-with-suggestions">
            <input
              class="key-input"
              type="text"
              value={row.key}
              aria-label="Field key"
              aria-autocomplete="list"
              onfocus={(e) =>
                openKeySuggestions(row, e.currentTarget.value)}
              oninput={(e) =>
                openKeySuggestions(row, e.currentTarget.value)}
              onblur={(e) => {
                dismissSuggestions();
                commitKey(row, e.currentTarget.value, e.currentTarget);
              }}
              onkeydown={(e) => {
                if (handleSuggestionKeydown(e, row, "key")) return;
                if (e.key === "Enter") {
                  // Enter commits the rename (via blur) and hands focus
                  // to the value input inside the same row.
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
            {#if suggestionActiveFor(row.id, "key")}
              <SuggestionList
                suggestions={activeSuggestion!.suggestions}
                selectedIndex={activeSuggestion!.selectedIndex}
                onPick={(picked) => {
                  const input = panelRoot?.querySelector<HTMLInputElement>(
                    `[data-row-id="${row.id}"] .key-input`,
                  );
                  if (input) pickSuggestion(row, picked, input);
                }}
                onHover={highlightSuggestion}
              />
            {/if}
          </div>

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
              <div class="input-with-suggestions">
                <input
                  class="value-input"
                  type="text"
                  value={stringifyValue(value)}
                  aria-label="Field value"
                  aria-autocomplete="list"
                  onfocus={(e) =>
                    openValueSuggestions(row, e.currentTarget.value)}
                  oninput={(e) =>
                    openValueSuggestions(row, e.currentTarget.value)}
                  onblur={(e) => {
                    dismissSuggestions();
                    commitValue(row, e.currentTarget.value, type);
                  }}
                  onkeydown={(e) => {
                    if (handleSuggestionKeydown(e, row, "value")) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                />
                {#if suggestionActiveFor(row.id, "value")}
                  <SuggestionList
                    suggestions={activeSuggestion!.suggestions}
                    selectedIndex={activeSuggestion!.selectedIndex}
                    onPick={(picked) => {
                      const input =
                        panelRoot?.querySelector<HTMLInputElement>(
                          `[data-row-id="${row.id}"] .value-input`,
                        );
                      if (input) pickSuggestion(row, picked, input);
                    }}
                    onHover={highlightSuggestion}
                  />
                {/if}
              </div>
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

  /* Wrapper for an input + its anchored autocomplete dropdown. Positioned
     so the SuggestionList (which uses position: absolute) pins itself to
     the wrapper's bottom edge regardless of the row's overall layout. */
  .input-with-suggestions {
    position: relative;
    width: 100%;
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
