<script lang="ts">
  // Floating personal-dictionary editor.
  //
  // Mirrors the FrontmatterPanel pattern — same orthogonal-tool ethos,
  // same 180ms grid-row + opacity-fade animation, same Escape /
  // click-outside dismissal — but the content is simpler: a list of
  // words with × buttons and a single "Add word…" input at the bottom.
  // No type dispatching, no chip input, no autocomplete.
  //
  // Mutual exclusion with the frontmatter panel: opening this panel
  // closes the frontmatter panel (and vice versa) so they never overlap
  // in the same top-right anchor zone. Implemented via a $effect that
  // calls `project.closeFrontmatterPanel()` whenever this one opens.

  import { project } from "$lib/stores/project.svelte";
  import { preferences } from "$lib/stores/preferences.svelte";

  let panelRoot: HTMLDivElement | undefined = $state();
  let pendingWord = $state("");

  // Words sorted alphabetically (case-insensitive). The Rust side stores
  // insertion order; the visual order is whatever's most useful for
  // skimming, which is alphabetical.
  let sortedWords = $derived(
    [...preferences.personalDictionary].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    ),
  );

  // Mutual exclusion with the frontmatter panel. Opening either one
  // closes the other. Cheap and clear.
  $effect(() => {
    if (preferences.dictionaryPanelOpen && project.frontmatterPanelOpen) {
      project.closeFrontmatterPanel();
    }
  });

  function commitPendingWord() {
    const text = pendingWord.trim();
    if (text.length === 0) return;
    preferences.addPersonalWord(text);
    pendingWord = "";
  }

  function handlePendingKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitPendingWord();
    }
  }

  function handleRootKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      preferences.closeDictionaryPanel();
    }
  }

  $effect(() => {
    if (!preferences.dictionaryPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (!panelRoot) return;
      const target = e.target as Node | null;
      if (target && !panelRoot.contains(target)) {
        // Ignore clicks on the Aa indicator itself — its own click
        // handler toggles the panel and we don't want both handlers
        // to fire.
        const hit = (target as Element | null)?.closest?.(
          ".aa-indicator",
        );
        if (hit) return;
        preferences.closeDictionaryPanel();
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
  class="dict-panel-wrapper"
  class:dict-panel-open={preferences.dictionaryPanelOpen}
  aria-hidden={!preferences.dictionaryPanelOpen}
>
  <div
    class="dict-panel"
    bind:this={panelRoot}
    role="dialog"
    tabindex="-1"
    aria-label="Personal dictionary"
    onkeydown={handleRootKeydown}
  >
    <header class="dict-panel-header">
      <span class="dict-panel-title">Personal dictionary</span>
      <span class="dict-panel-count">{sortedWords.length}</span>
    </header>

    <div class="dict-panel-body">
      {#if sortedWords.length === 0}
        <p class="dict-empty">
          No words yet. Add a word below or position the cursor on a
          word in the editor and press <kbd>⌘'</kbd>.
        </p>
      {/if}

      <ul class="dict-words">
        {#each sortedWords as word (word.toLowerCase())}
          <li class="dict-word">
            <span class="dict-word-text" title={word}>{word}</span>
            <button
              type="button"
              class="dict-remove"
              aria-label={`Remove ${word}`}
              title="Remove from dictionary"
              onclick={() => preferences.removePersonalWord(word)}
            >
              ×
            </button>
          </li>
        {/each}
      </ul>
    </div>

    <footer class="dict-panel-footer">
      <input
        class="dict-add-input"
        type="text"
        placeholder="Add a word…"
        bind:value={pendingWord}
        onkeydown={handlePendingKeydown}
        onblur={commitPendingWord}
      />
    </footer>
  </div>
</div>

<style>
  .dict-panel-wrapper {
    position: absolute;
    top: 48px;
    right: 12px;
    width: 22rem;
    max-width: calc(100vw - 24px);
    z-index: 100;

    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 180ms cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: none;
  }

  .dict-panel-wrapper.dict-panel-open {
    grid-template-rows: 1fr;
    pointer-events: auto;
  }

  .dict-panel {
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

  .dict-panel-wrapper.dict-panel-open .dict-panel {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .dict-panel-wrapper,
    .dict-panel {
      transition: none;
    }
  }

  .dict-panel-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--skrive-rule);
    flex-shrink: 0;
    background: var(--skrive-bg);
  }

  .dict-panel-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    color: var(--skrive-fg);
  }

  .dict-panel-count {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
  }

  .dict-panel-body {
    padding: 0.5rem 0;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    font-size: 13px;
  }

  .dict-empty {
    margin: 0;
    padding: 0.5rem 0.875rem 0.75rem;
    font-size: 12px;
    color: var(--skrive-muted);
    line-height: 1.5;
  }

  .dict-empty kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    background: var(--skrive-rule);
    padding: 0.05em 0.35em;
    border-radius: 3px;
    color: var(--skrive-fg);
  }

  .dict-words {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .dict-word {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.3rem 0.875rem;
  }

  .dict-word + .dict-word {
    border-top: 1px dashed var(--skrive-rule);
  }

  .dict-word-text {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--skrive-fg);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .dict-remove {
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
    flex-shrink: 0;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .dict-remove:hover {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  .dict-panel-footer {
    padding: 0.5rem 0.875rem;
    border-top: 1px solid var(--skrive-rule);
    flex-shrink: 0;
  }

  .dict-add-input {
    background: transparent;
    border: 1px solid var(--skrive-rule);
    border-radius: 3px;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 12px;
    padding: 0.4rem 0.5rem;
    width: 100%;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .dict-add-input:focus {
    border-color: var(--skrive-fg);
  }

  .dict-add-input::placeholder {
    color: var(--skrive-muted);
  }
</style>
