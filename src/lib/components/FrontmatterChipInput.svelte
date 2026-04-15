<script lang="ts">
  // Editable chip group for frontmatter array values.
  //
  // Every chip is a single string element of the array. A trailing input
  // sits after the last chip for adding new entries — type, press Enter
  // or comma to commit, press Backspace on an empty input to delete the
  // previous chip. Clicking a chip's × removes it immediately; clicking
  // the chip body itself flips the chip into an inline edit state that
  // reuses the same keyboard rules as the trailing input.
  //
  // Why a component: the commas-in-values problem. A text input that
  // splits on commas silently mangles `authors: ["Last, First"]` — a
  // real and common pattern for author lists, place names, and anything
  // with a punctuation pause in the label. One chip per element with an
  // explicit commit gesture (Enter or the dedicated comma key) is the
  // only edit contract that preserves punctuation.
  //
  // The component's external interface is string-array in, string-array
  // out via `onChange`. Internal state (which chip is being edited, what
  // text is in the trailing input) is local to this component and never
  // surfaces to the parent.

  type Props = {
    value: string[];
    onChange: (next: string[]) => void;
    /**
     * Placeholder shown in the trailing input when no chips exist yet.
     * Defaults to nothing so the empty state is minimal.
     */
    placeholder?: string;
  };

  let { value, onChange, placeholder = "" }: Props = $props();

  // Local state: the text in the trailing "add new chip" input, and the
  // index of the chip currently being edited (or -1 if none).
  let pendingText = $state("");
  let editingIndex = $state(-1);
  let editingText = $state("");

  function commitPending() {
    const trimmed = pendingText.trim();
    if (trimmed.length === 0) {
      pendingText = "";
      return;
    }
    onChange([...value, trimmed]);
    pendingText = "";
  }

  function handlePendingKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitPending();
    } else if (e.key === "Backspace" && pendingText.length === 0 && value.length > 0) {
      // Backspace on an empty input removes the previous chip. This is
      // how chip editors "feel" correct — deleting backwards from the
      // trailing input walks off the end of the array one chip at a time.
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  function removeChip(index: number) {
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
    // If we were editing a chip that just got removed, cancel the edit.
    if (editingIndex === index) {
      editingIndex = -1;
      editingText = "";
    } else if (editingIndex > index) {
      editingIndex -= 1;
    }
  }

  function beginEdit(index: number) {
    editingIndex = index;
    editingText = value[index];
  }

  function commitEdit() {
    if (editingIndex < 0) return;
    const trimmed = editingText.trim();
    if (trimmed.length === 0) {
      // Empty edit → remove the chip.
      removeChip(editingIndex);
      return;
    }
    const next = value.slice();
    next[editingIndex] = trimmed;
    onChange(next);
    editingIndex = -1;
    editingText = "";
  }

  function cancelEdit() {
    editingIndex = -1;
    editingText = "";
  }

  function handleEditKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }
</script>

<div class="chip-group" role="list">
  {#each value as chip, i (i + "::" + chip)}
    {#if editingIndex === i}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="chip-edit"
        type="text"
        bind:value={editingText}
        onkeydown={handleEditKey}
        onblur={commitEdit}
        autofocus
      />
    {:else}
      <span class="chip" role="listitem">
        <button
          type="button"
          class="chip-label"
          onclick={() => beginEdit(i)}
          title="Click to edit"
        >
          {chip}
        </button>
        <button
          type="button"
          class="chip-remove"
          aria-label="Remove {chip}"
          onclick={() => removeChip(i)}
        >
          ×
        </button>
      </span>
    {/if}
  {/each}

  <input
    class="chip-pending"
    type="text"
    bind:value={pendingText}
    onkeydown={handlePendingKey}
    onblur={commitPending}
    placeholder={value.length === 0 ? placeholder : ""}
  />
</div>

<style>
  .chip-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.25rem 0.375rem;
    border: 1px solid var(--skrive-rule);
    border-radius: 3px;
    background: var(--skrive-bg);
    min-height: 26px;
    align-items: center;
    transition: border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .chip-group:focus-within {
    border-color: var(--skrive-fg);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0;
    background: var(--skrive-rule);
    border-radius: 3px;
    font-size: 12px;
    line-height: 1;
    overflow: hidden;
  }

  .chip-label {
    background: transparent;
    border: none;
    color: var(--skrive-fg);
    cursor: pointer;
    padding: 0.25rem 0.25rem 0.25rem 0.5rem;
    font: inherit;
    font-size: 12px;
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  .chip-remove {
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    cursor: pointer;
    padding: 0.25rem 0.375rem;
    font: inherit;
    font-size: 14px;
    line-height: 1;
    transition: color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .chip-remove:hover {
    color: var(--skrive-fg);
  }

  .chip-edit {
    background: var(--skrive-bg);
    border: 1px solid var(--skrive-fg);
    border-radius: 3px;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 12px;
    padding: 0.2rem 0.4rem;
    min-width: 4rem;
    width: auto;
    outline: none;
    box-sizing: border-box;
  }

  .chip-pending {
    background: transparent;
    border: none;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 12px;
    padding: 0.25rem 0.25rem;
    flex: 1;
    min-width: 6rem;
    outline: none;
  }

  .chip-pending::placeholder {
    color: var(--skrive-muted);
  }
</style>
