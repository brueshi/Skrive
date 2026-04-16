<script lang="ts">
  // Generic suggestion dropdown. Stays deliberately dumb: it owns no
  // filtering, no sorting, no async fetching. The parent computes the
  // suggestion list and the selected index; this component renders them
  // and emits pick / hover events.
  //
  // Designed to be anchored to an input via CSS — the parent wraps the
  // input + dropdown in a `position: relative` container and the dropdown
  // pins itself to `top: 100%` of that container. No portal or floating
  // UI library; we don't have arbitrary z-index conflicts to navigate yet
  // and the panel itself is the highest-z element on the page.
  //
  // The crucial bit of plumbing is `onmousedown` on each option: it calls
  // `e.preventDefault()` so that mousing-down on a suggestion does NOT blur
  // the anchored input, which would otherwise tear down the suggestion
  // dropdown before the click event registers.

  type Props = {
    suggestions: string[];
    selectedIndex: number;
    onPick: (value: string, index: number) => void;
    onHover: (index: number) => void;
  };

  let { suggestions, selectedIndex, onPick, onHover }: Props = $props();
</script>

{#if suggestions.length > 0}
  <ul class="suggestion-list" role="listbox">
    {#each suggestions as suggestion, i (suggestion + "::" + i)}
      <li
        class="suggestion"
        class:selected={i === selectedIndex}
        role="option"
        aria-selected={i === selectedIndex}
        onmousedown={(e) => {
          // Prevent the input from blurring before our click handler runs.
          e.preventDefault();
          onPick(suggestion, i);
        }}
        onmouseenter={() => onHover(i)}
      >
        {suggestion}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .suggestion-list {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    background: var(--skrive-bg);
    border: 1px solid var(--skrive-fg);
    border-radius: 3px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    z-index: 10;
    max-height: 12rem;
    overflow-y: auto;
    font-size: 12px;
  }

  .suggestion {
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    color: var(--skrive-fg);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background-color 0.06s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .suggestion.selected {
    background: var(--skrive-rule);
    color: var(--skrive-fg);
  }
</style>
