<script lang="ts">
  // Settings view rendered inside the workspace area when
  // `project.activeView === "settings"`. Modeled after VS Code's
  // settings tab: a left-rail of section labels and a scrollable
  // content pane on the right. Lives inside the same workspace shell
  // as the editor so opening Settings doesn't disrupt the project's
  // tab strip, sidebar, or panels.
  //
  // Scope for alpha: surface the settings the app already persists
  // through `preferences.svelte.ts`, plus discoverability for updater
  // and licence/version. We deliberately do *not* expose theme,
  // editor-font, or default-project-location yet — those settings
  // don't exist in the store, and stubbing them would create a
  // promise we can't keep.

  import { preferences } from "$lib/stores/preferences.svelte";
  import { checkForUpdatesManual } from "$lib/updater";
  import { notify } from "$lib/stores/notifications.svelte";
  import { formatError } from "$lib/errors";
  import { EDITOR_FONT_PRESETS } from "$lib/editor/fonts";
  import type { EditorFontId } from "$lib/types";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { appDataDir, join } from "@tauri-apps/api/path";

  type SectionId =
    | "general"
    | "editor"
    | "dictionary"
    | "updates"
    | "about";

  type Section = {
    id: SectionId;
    label: string;
  };

  const SECTIONS: Section[] = [
    { id: "general", label: "General" },
    { id: "editor", label: "Editor" },
    { id: "dictionary", label: "Personal dictionary" },
    { id: "updates", label: "Updates" },
    { id: "about", label: "About" },
  ];

  // Stepped controls keep the editorial vibe — sliders feel like a
  // generic settings panel. The defaults live in `preferences` and
  // also drive the "Reset to defaults" button.
  const FONT_SIZE_STEPS = [14, 16, 17, 18, 20, 22] as const;
  const LINE_HEIGHT_STEPS = [
    { x100: 150, label: "1.5" },
    { x100: 170, label: "1.7" },
    { x100: 200, label: "2.0" },
  ] as const;

  let activeSection = $state<SectionId>("general");

  // Hard-coded for now. We could read this from `package.json` via a
  // build-time import, but the version is the same string in three
  // places (package.json, tauri.conf.json, the release tags) and
  // syncing them is already the release process.
  const APP_VERSION = "0.1.0";
  const APP_LICENSE = "PolyForm Noncommercial 1.0.0";

  let pendingWord = $state("");

  let sortedWords = $derived(
    [...preferences.personalDictionary].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    ),
  );

  function commitPendingWord() {
    const text = pendingWord.trim();
    if (text.length === 0) return;
    preferences.addPersonalWord(text);
    pendingWord = "";
  }

  function handleDictKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitPendingWord();
    }
  }

  async function handleCheckForUpdates() {
    try {
      await checkForUpdatesManual();
    } catch (err) {
      notify.error("Couldn't check for updates", err);
    }
  }

  async function handleRevealPreferences() {
    try {
      const dir = await appDataDir();
      // The store writes to `app.json` under the app data dir. We
      // reveal *the file* rather than the directory so Finder/Explorer
      // highlights it on open. On a brand-new install the file may
      // not exist yet (no save has fired), so fall back to revealing
      // the containing directory — better than a confusing failure.
      const path = await join(dir, "app.json");
      try {
        await revealItemInDir(path);
      } catch {
        await revealItemInDir(dir);
      }
    } catch (err) {
      notify.error(
        `Couldn't reveal preferences: ${formatError(err)}`,
        err,
      );
    }
  }

  function handleSelectFont(id: EditorFontId) {
    preferences.setEditorFont(id);
  }
</script>

<section class="settings" aria-label="Settings">
  <nav class="settings-nav" aria-label="Settings sections">
    <ul class="settings-nav-list">
      {#each SECTIONS as section (section.id)}
        <li>
          <button
            type="button"
            class="settings-nav-item"
            class:active={activeSection === section.id}
            aria-current={activeSection === section.id ? "page" : undefined}
            onclick={() => (activeSection = section.id)}
          >
            {section.label}
          </button>
        </li>
      {/each}
    </ul>
  </nav>

  <div class="settings-pane">
    {#if activeSection === "general"}
      <header class="settings-pane-header">
        <h2>General</h2>
        <p class="settings-pane-blurb">
          App-wide behavior. These settings apply across every project
          you open.
        </p>
      </header>

      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-label">Skip delete confirmation</span>
            <span class="settings-row-help">
              When on, deleting a file in the sidebar moves it to the
              trash without prompting. The OS trash is the safety net.
            </span>
          </div>
          <label class="toggle">
            <input
              type="checkbox"
              checked={preferences.skipDeleteConfirmation}
              onchange={(e) =>
                preferences.setSkipDeleteConfirmation(
                  (e.currentTarget as HTMLInputElement).checked,
                )}
            />
            <span class="toggle-track" aria-hidden="true">
              <span class="toggle-thumb"></span>
            </span>
          </label>
        </div>
      </div>
    {/if}

    {#if activeSection === "editor"}
      <header class="settings-pane-header">
        <h2>Editor</h2>
        <p class="settings-pane-blurb">
          Pick the typeface, size, and line height that works for the
          way you read. Five curated presets cover the common cases;
          Custom lets you point at any font you have installed.
        </p>
      </header>

      <div class="settings-group">
        <div class="settings-row settings-row--stack">
          <div class="settings-row-text">
            <span class="settings-row-label">Font</span>
            <span class="settings-row-help">
              Each tile previews itself in its own typeface so you can
              spot the right mood at a glance.
            </span>
          </div>

          <div class="font-grid" role="radiogroup" aria-label="Editor font">
            {#each EDITOR_FONT_PRESETS as preset (preset.id)}
              <button
                type="button"
                role="radio"
                class="font-tile"
                class:active={preferences.editorFont === preset.id}
                aria-checked={preferences.editorFont === preset.id}
                style:font-family={preset.id === "custom"
                  ? undefined
                  : preset.stack}
                onclick={() => handleSelectFont(preset.id)}
              >
                <span class="font-tile-label">{preset.label}</span>
                <span class="font-tile-subtext">{preset.subtext}</span>
              </button>
            {/each}
          </div>
        </div>

        {#if preferences.editorFont === "custom"}
          <div class="settings-row settings-row--stack">
            <div class="settings-row-text">
              <span class="settings-row-label">Custom font family</span>
              <span class="settings-row-help">
                Type the name of any font installed on your system
                (e.g. <em>Crimson Pro</em>, <em>EB Garamond</em>,
                <em>Inter</em>). Falls back to Editorial if the font
                isn't found.
              </span>
            </div>
            <input
              class="text-input"
              type="text"
              placeholder="e.g. Crimson Pro"
              value={preferences.editorCustomFontFamily}
              oninput={(e) =>
                preferences.setEditorCustomFontFamily(
                  (e.currentTarget as HTMLInputElement).value,
                )}
            />
          </div>
        {/if}

        <div class="settings-row settings-row--stack">
          <div class="settings-row-text">
            <span class="settings-row-label">Size</span>
            <span class="settings-row-help">
              In pixels. Default is 17.
            </span>
          </div>
          <div class="step-row" role="radiogroup" aria-label="Font size">
            {#each FONT_SIZE_STEPS as size (size)}
              <button
                type="button"
                role="radio"
                class="step-button"
                class:active={preferences.editorFontSize === size}
                aria-checked={preferences.editorFontSize === size}
                onclick={() => preferences.setEditorFontSize(size)}
              >
                {size}
              </button>
            {/each}
          </div>
        </div>

        <div class="settings-row settings-row--stack">
          <div class="settings-row-text">
            <span class="settings-row-label">Line height</span>
            <span class="settings-row-help">
              Tighter for dense reading, looser for breathing room.
              Default is 1.7.
            </span>
          </div>
          <div class="step-row" role="radiogroup" aria-label="Line height">
            {#each LINE_HEIGHT_STEPS as step (step.x100)}
              <button
                type="button"
                role="radio"
                class="step-button"
                class:active={preferences.editorLineHeightX100 === step.x100}
                aria-checked={preferences.editorLineHeightX100 === step.x100}
                onclick={() =>
                  preferences.setEditorLineHeightX100(step.x100)}
              >
                {step.label}
              </button>
            {/each}
          </div>
        </div>

        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-label">Reset typography</span>
            <span class="settings-row-help">
              Restore the default font, size, and line height.
            </span>
          </div>
          <button
            type="button"
            class="text-button"
            onclick={() => preferences.resetEditorTypography()}
          >
            Reset to defaults
          </button>
        </div>
      </div>
    {/if}

    {#if activeSection === "dictionary"}
      <header class="settings-pane-header">
        <h2>Personal dictionary</h2>
        <p class="settings-pane-blurb">
          Words you've taught Skrive to ignore. Added words are matched
          case-insensitively across every project.
        </p>
      </header>

      <div class="settings-group">
        <div class="dict-add">
          <input
            class="text-input"
            type="text"
            placeholder="Add a word…"
            bind:value={pendingWord}
            onkeydown={handleDictKeydown}
            onblur={commitPendingWord}
          />
        </div>

        {#if sortedWords.length === 0}
          <p class="settings-empty">
            No words yet. Add one above, or position the cursor on a
            word in the editor and press <kbd>⌘'</kbd>.
          </p>
        {:else}
          <ul class="dict-list">
            {#each sortedWords as word (word.toLowerCase())}
              <li class="dict-row">
                <span class="dict-word">{word}</span>
                <button
                  type="button"
                  class="dict-remove"
                  aria-label={`Remove ${word}`}
                  onclick={() => preferences.removePersonalWord(word)}
                >
                  ×
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if activeSection === "updates"}
      <header class="settings-pane-header">
        <h2>Updates</h2>
        <p class="settings-pane-blurb">
          Skrive checks for updates silently on launch. Use the button
          below to check on demand, or turn the launch check off if
          you'd rather control when it runs.
        </p>
      </header>

      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-label">Check for updates on launch</span>
            <span class="settings-row-help">
              When on, Skrive quietly checks once at startup and shows
              a toast if a new release is available. Off means you
              decide when to check.
            </span>
          </div>
          <label class="toggle">
            <input
              type="checkbox"
              checked={preferences.autoUpdateOnLaunch}
              onchange={(e) =>
                preferences.setAutoUpdateOnLaunch(
                  (e.currentTarget as HTMLInputElement).checked,
                )}
            />
            <span class="toggle-track" aria-hidden="true">
              <span class="toggle-thumb"></span>
            </span>
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-label">Current version</span>
            <span class="settings-row-help">{APP_VERSION}</span>
          </div>
          <button
            type="button"
            class="text-button"
            onclick={handleCheckForUpdates}
          >
            Check for updates…
          </button>
        </div>
      </div>
    {/if}

    {#if activeSection === "about"}
      <header class="settings-pane-header">
        <h2>About Skrive</h2>
        <p class="settings-pane-blurb">
          A Markdown IDE for people who write seriously and ship to the
          web.
        </p>
      </header>

      <div class="settings-group">
        <dl class="settings-defs">
          <div class="settings-def">
            <dt>Version</dt>
            <dd>{APP_VERSION}</dd>
          </div>
          <div class="settings-def">
            <dt>License</dt>
            <dd>{APP_LICENSE}</dd>
          </div>
        </dl>

        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-label">Reveal preferences</span>
            <span class="settings-row-help">
              Open the folder containing Skrive's <code>app.json</code>.
              Useful when reporting bugs — share the file so the
              maintainers can reproduce your setup.
            </span>
          </div>
          <button
            type="button"
            class="text-button"
            onclick={handleRevealPreferences}
          >
            Reveal in Finder
          </button>
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .settings {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 14rem 1fr;
    background: var(--skrive-bg);
    color: var(--skrive-fg);
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  }

  .settings-nav {
    border-right: 1px solid var(--skrive-rule);
    overflow-y: auto;
    padding: 1.25rem 0.75rem;
  }

  .settings-nav-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .settings-nav-item {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    font: inherit;
    font-size: 13px;
    padding: 0.4rem 0.625rem;
    border-radius: 3px;
    cursor: pointer;
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .settings-nav-item:hover {
    background: var(--skrive-rule);
    color: var(--skrive-fg);
  }

  .settings-nav-item.active {
    background: var(--skrive-rule);
    color: var(--skrive-fg);
    font-weight: 500;
  }

  .settings-pane {
    overflow-y: auto;
    padding: 2rem 2.5rem;
    max-width: 48rem;
    width: 100%;
    box-sizing: border-box;
  }

  .settings-pane-header {
    margin-bottom: 1.5rem;
    padding-bottom: 0.875rem;
    border-bottom: 1px solid var(--skrive-rule);
  }

  .settings-pane-header h2 {
    margin: 0 0 0.25rem;
    font-size: 18px;
    font-weight: 600;
    color: var(--skrive-fg);
  }

  .settings-pane-blurb {
    margin: 0;
    font-size: 13px;
    color: var(--skrive-muted);
    line-height: 1.5;
  }

  .settings-group {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .settings-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 0.75rem 0;
  }

  /* Variant for rows where the control is too wide or visually busy
     to sit beside the label (font grid, custom-font input). Stacks
     control below the label-and-help block. */
  .settings-row--stack {
    flex-direction: column;
    gap: 0.625rem;
  }

  .settings-row--stack .settings-row-text {
    flex: 0 0 auto;
  }

  .settings-row-text {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    flex: 1;
  }

  .settings-row-label {
    font-size: 13px;
    color: var(--skrive-fg);
    font-weight: 500;
  }

  .settings-row-help {
    font-size: 12px;
    color: var(--skrive-muted);
    line-height: 1.5;
  }

  .settings-empty {
    margin: 0;
    padding: 0.75rem 0;
    font-size: 13px;
    color: var(--skrive-muted);
    line-height: 1.5;
  }

  .settings-empty kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    background: var(--skrive-rule);
    padding: 0.05em 0.35em;
    border-radius: 3px;
    color: var(--skrive-fg);
  }

  /* ---- Toggle switch ---- */
  .toggle {
    position: relative;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    flex-shrink: 0;
  }

  .toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-track {
    width: 32px;
    height: 18px;
    border-radius: 999px;
    background: var(--skrive-rule);
    border: 1px solid var(--skrive-muted);
    position: relative;
    transition: background-color 0.16s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 999px;
    background: var(--skrive-fg);
    transition: transform 0.16s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .toggle input:checked + .toggle-track {
    background: var(--skrive-fg);
    border-color: var(--skrive-fg);
  }

  .toggle input:checked + .toggle-track .toggle-thumb {
    transform: translateX(14px);
    background: var(--skrive-bg);
  }

  .toggle input:focus-visible + .toggle-track {
    outline: 2px solid var(--skrive-fg);
    outline-offset: 2px;
  }

  /* ---- Inputs / buttons ---- */
  .text-input {
    background: transparent;
    border: 1px solid var(--skrive-rule);
    border-radius: 3px;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 13px;
    padding: 0.45rem 0.6rem;
    width: 100%;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .text-input:focus {
    border-color: var(--skrive-fg);
  }

  .text-input::placeholder {
    color: var(--skrive-muted);
  }

  .text-button {
    background: transparent;
    border: 1px solid var(--skrive-rule);
    color: var(--skrive-fg);
    font: inherit;
    font-size: 12px;
    padding: 0.4rem 0.75rem;
    border-radius: 3px;
    cursor: pointer;
    flex-shrink: 0;
    transition:
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .text-button:hover {
    background: var(--skrive-rule);
    border-color: var(--skrive-fg);
  }

  /* ---- Dictionary list ---- */
  .dict-add {
    margin-bottom: 0.25rem;
  }

  .dict-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--skrive-rule);
  }

  .dict-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.45rem 0;
    border-bottom: 1px dashed var(--skrive-rule);
  }

  .dict-word {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--skrive-fg);
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
    font-size: 16px;
    line-height: 1;
    border-radius: 3px;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .dict-remove:hover {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  /* ---- Font picker grid ---- */
  .font-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
    width: 100%;
  }

  .font-tile {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
    padding: 0.65rem 0.75rem;
    background: transparent;
    border: 1px solid var(--skrive-rule);
    border-radius: 4px;
    color: var(--skrive-fg);
    cursor: pointer;
    transition:
      border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
    text-align: left;
  }

  .font-tile:hover {
    border-color: var(--skrive-fg);
  }

  .font-tile.active {
    border-color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  .font-tile-label {
    font-size: 15px;
    font-weight: 500;
  }

  .font-tile-subtext {
    font-size: 11px;
    color: var(--skrive-muted);
    /* Subtext should always read in the UI font, never in the tile's
       custom typeface — otherwise "System monospace" rendered in
       monospace would feel like a redundant punchline. */
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  }

  /* ---- Stepped numeric controls ---- */
  .step-row {
    display: inline-flex;
    border: 1px solid var(--skrive-rule);
    border-radius: 4px;
    overflow: hidden;
    width: fit-content;
  }

  .step-button {
    background: transparent;
    border: none;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 12px;
    padding: 0.4rem 0.85rem;
    cursor: pointer;
    transition: background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
    font-variant-numeric: tabular-nums;
    /* Render numerical labels in the UI font, not whatever the user
       picked for the editor — keeps the picker legible regardless of
       the current `--skrive-editor-font`. */
    font-family:
      -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  }

  .step-button + .step-button {
    border-left: 1px solid var(--skrive-rule);
  }

  .step-button:hover {
    background: var(--skrive-rule);
  }

  .step-button.active {
    background: var(--skrive-fg);
    color: var(--skrive-bg);
  }

  .step-button.active + .step-button {
    border-left-color: var(--skrive-fg);
  }

  /* ---- Inline code in help text ---- */
  .settings-row-help code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    background: var(--skrive-rule);
    padding: 0.05em 0.3em;
    border-radius: 3px;
  }

  /* ---- About defs list ---- */
  .settings-defs {
    margin: 0;
    display: grid;
    grid-template-columns: 8rem 1fr;
    row-gap: 0.5rem;
    column-gap: 1rem;
    font-size: 13px;
  }

  .settings-def {
    display: contents;
  }

  .settings-def dt {
    color: var(--skrive-muted);
  }

  .settings-def dd {
    color: var(--skrive-fg);
    margin: 0;
  }
</style>
