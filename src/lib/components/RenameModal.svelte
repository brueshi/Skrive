<script lang="ts">
  // Rename-with-references confirmation modal.
  //
  // Shown when the user invokes rename via F2 on an active tab or the
  // "Rename…" context-menu item on a sidebar row. The modal displays:
  //
  //   - The target file's directory prefix (read-only).
  //   - An editable name input, preseeded with the current basename
  //     and with the stem (name-without-extension) selected so typing
  //     replaces it cleanly. The input accepts path separators: typing
  //     `docs/foo.md` moves the file into a `docs/` subdirectory of the
  //     current location, creating intermediate folders as needed. The
  //     backend's `rename_with_references` already handles fresh-subpath
  //     moves and rewrites inbound references to the new location.
  //   - A live preview of every reference the commit will rewrite.
  //   - Cancel + Rename buttons.
  //
  // The preview is debounced: every keystroke schedules a
  // `preview_rename` call 120ms later, and the most recent in-flight
  // result wins. Stale responses from earlier typing are dropped by
  // comparing against a monotonically-increasing sequence number.
  //
  // Step 5 leaves the commit path unwired. Clicking Rename fires the
  // `onCommit` prop, which +page.svelte currently stubs with a
  // notification. Step 6 will swap the stub for the real Rust call.

  import { invoke } from "@tauri-apps/api/core";
  import type { Reference, RenamePreview } from "$lib/types";

  type Props = {
    oldPath: string;
    onClose: () => void;
    onCommit: (newPath: string) => void;
  };

  let { oldPath, onClose, onCommit }: Props = $props();

  // `oldPath` is a rune-reactive prop. Read it through `$derived` so
  // Svelte doesn't warn about capturing the initial value — even though
  // the modal re-mounts per rename request, the derived form is
  // still the right shape for the rune system to track.
  const dirPrefix = $derived.by(() => {
    const slash = oldPath.lastIndexOf("/");
    return slash >= 0 ? oldPath.slice(0, slash + 1) : "";
  });
  const initialBasename = $derived.by(() => {
    const slash = oldPath.lastIndexOf("/");
    return slash >= 0 ? oldPath.slice(slash + 1) : oldPath;
  });

  let basenameInput: HTMLInputElement | undefined = $state();
  // Seed `pendingBasename` from `oldPath` via a closure so the read
  // registers as a closure capture and doesn't trip the
  // state_referenced_locally warning. The modal re-mounts per rename
  // request, so this IIFE runs exactly once per opened modal.
  let pendingBasename = $state(
    (() => {
      const slash = oldPath.lastIndexOf("/");
      return slash >= 0 ? oldPath.slice(slash + 1) : oldPath;
    })(),
  );
  let preview = $state<RenamePreview | null>(null);
  let previewPending = $state(false);
  let inputError = $state<string | null>(null);

  // Sequence counter so stale debounced responses can't clobber fresh ones.
  let previewSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 120;

  const newPath = $derived(dirPrefix + pendingBasename.trim());

  const isInvalidBasename = $derived.by(() => {
    const b = pendingBasename.trim();
    if (b.length === 0) return "Name can't be empty.";
    if (b.includes("\\")) {
      return "Name can't contain backslashes.";
    }
    if (b.startsWith("/")) {
      return "Name can't start with /.";
    }
    const segments = b.split("/");
    if (segments.some((s) => s.length === 0)) {
      return "Name can't contain empty path segments.";
    }
    if (segments.some((s) => s === "." || s === "..")) {
      return "Name can't contain . or .. segments.";
    }
    const last = segments[segments.length - 1];
    if (!last.endsWith(".md") && !last.endsWith(".markdown")) {
      return "Name must end with .md or .markdown.";
    }
    return null;
  });

  const canRename = $derived(
    isInvalidBasename === null &&
      preview !== null &&
      !preview.targetExists &&
      !previewPending,
  );

  $effect(() => {
    // Focus and select the stem portion on mount so the user can start
    // typing immediately without clearing.
    if (!basenameInput) return;
    basenameInput.focus();
    const dot = initialBasename.lastIndexOf(".");
    if (dot > 0) {
      basenameInput.setSelectionRange(0, dot);
    } else {
      basenameInput.select();
    }
  });

  $effect(() => {
    // Trigger a debounced preview whenever the input changes.
    // Read the reactive value so the effect re-fires on edit.
    const _candidate = newPath;
    void _candidate;

    if (debounceTimer) clearTimeout(debounceTimer);
    previewPending = true;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runPreview();
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  async function runPreview() {
    // Skip the IPC call for input we already know is invalid — no point
    // round-tripping to Rust when the basename is empty or missing its
    // extension.
    if (isInvalidBasename !== null) {
      preview = null;
      previewPending = false;
      return;
    }
    const seq = ++previewSeq;
    try {
      const result = await invoke<RenamePreview>("preview_rename", {
        oldPath,
        newPath,
      });
      if (seq !== previewSeq) return;
      preview = result;
      inputError = null;
    } catch (err) {
      if (seq !== previewSeq) return;
      preview = null;
      inputError = String(err);
    } finally {
      if (seq === previewSeq) previewPending = false;
    }
  }

  function handleInputKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (canRename) commitNow();
    }
  }

  function handleRootKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function commitNow() {
    if (!canRename) return;
    onCommit(newPath);
  }

  function kindLabel(kind: Reference["kind"]): string {
    switch (kind) {
      case "inline":
        return "inline";
      case "wiki":
        return "wiki";
      case "referenceUse":
        return "ref use";
      case "referenceDefinition":
        return "ref def";
    }
  }
</script>

<div
  class="rename-backdrop"
  onmousedown={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
  role="presentation"
>
  <div
    class="rename-modal"
    role="dialog"
    aria-modal="true"
    aria-label="Rename file"
    tabindex="-1"
    onkeydown={handleRootKeydown}
  >
    <header class="rename-header">
      <span class="rename-title">Rename</span>
      <span class="rename-old" title={oldPath}>{oldPath}</span>
    </header>

    <div class="rename-input-row">
      <span class="rename-prefix" title={dirPrefix || "(project root)"}
        >{dirPrefix}</span
      >
      <input
        bind:this={basenameInput}
        class="rename-basename"
        type="text"
        bind:value={pendingBasename}
        onkeydown={handleInputKeydown}
        aria-label="New basename"
        spellcheck="false"
        autocomplete="off"
      />
    </div>

    {#if isInvalidBasename !== null}
      <p class="rename-error">{isInvalidBasename}</p>
    {:else if preview?.targetExists}
      <p class="rename-error">A file already exists at {newPath}.</p>
    {:else if inputError}
      <p class="rename-error">{inputError}</p>
    {:else if pendingBasename.includes("/")}
      <p class="rename-moves-to">Moves to <span>{newPath}</span></p>
    {/if}

    <div class="rename-summary">
      {#if previewPending}
        <span class="rename-count-pending">Computing preview…</span>
      {:else if preview}
        {@const refCount = preview.references.length}
        {@const defCount = preview.definitionUpdates.length}
        {@const fileCount = new Set(
          preview.references.map((r) => r.path),
        ).size}
        <span class="rename-count">
          {refCount}
          {refCount === 1 ? "reference" : "references"}
          across
          {fileCount}
          {fileCount === 1 ? "file" : "files"}
        </span>
        {#if defCount > 0}
          <span class="rename-count-sep">·</span>
          <span class="rename-count-self"
            >{defCount}
            {defCount === 1 ? "self-reference" : "self-references"} inside the
            renamed file</span
          >
        {/if}
      {/if}
    </div>

    <div class="rename-preview">
      {#if preview && (preview.references.length > 0 || preview.definitionUpdates.length > 0)}
        <ul class="rename-rows">
          {#each preview.references as row (row.path + ":" + row.line + ":" + row.column)}
            <li class="rename-row">
              <span class="rename-row-kind">{kindLabel(row.kind)}</span>
              <span class="rename-row-path"
                >{row.path}<span class="rename-row-line">:{row.line}</span
                ></span
              >
              <span class="rename-row-snippet">{row.snippet}</span>
            </li>
          {/each}
          {#each preview.definitionUpdates as row (row.path + ":self:" + row.line + ":" + row.column)}
            <li class="rename-row rename-row-self">
              <span class="rename-row-kind">{kindLabel(row.kind)}</span>
              <span class="rename-row-path"
                >{row.path}<span class="rename-row-line">:{row.line}</span
                ><span class="rename-row-self-badge">self</span></span
              >
              <span class="rename-row-snippet">{row.snippet}</span>
            </li>
          {/each}
        </ul>
      {:else if preview}
        <p class="rename-empty">
          No references found. The rename will only move the file.
        </p>
      {/if}
    </div>

    <footer class="rename-footer">
      <button
        type="button"
        class="rename-button rename-button-cancel"
        onclick={onClose}
      >
        Cancel
      </button>
      <button
        type="button"
        class="rename-button rename-button-commit"
        disabled={!canRename}
        onclick={commitNow}
      >
        Rename
      </button>
    </footer>
  </div>
</div>

<style>
  .rename-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 200;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
  }

  .rename-modal {
    width: min(36rem, calc(100vw - 2rem));
    max-height: 70vh;
    background: var(--skrive-bg);
    border: 1px solid var(--skrive-fg);
    border-radius: 4px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .rename-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--skrive-rule);
  }

  .rename-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    color: var(--skrive-fg);
  }

  .rename-old {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .rename-input-row {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0.625rem 0.875rem 0.25rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .rename-prefix {
    color: var(--skrive-muted);
    font-size: 13px;
    user-select: none;
    flex-shrink: 0;
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rename-basename {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 1px solid var(--skrive-rule);
    border-radius: 3px;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 13px;
    padding: 0.35rem 0.5rem;
    outline: none;
    transition: border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .rename-basename:focus {
    border-color: var(--skrive-fg);
  }

  .rename-error {
    margin: 0.25rem 0.875rem 0;
    padding: 0.35rem 0.5rem;
    font-size: 12px;
    color: var(--skrive-fg);
    background: color-mix(in srgb, var(--skrive-fg) 8%, transparent);
    border-radius: 3px;
    border-left: 2px solid var(--skrive-fg);
  }

  .rename-moves-to {
    margin: 0.25rem 0.875rem 0;
    padding: 0.35rem 0.5rem;
    font-size: 12px;
    color: var(--skrive-muted);
  }

  .rename-moves-to span {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--skrive-fg);
  }

  .rename-summary {
    padding: 0.375rem 0.875rem;
    font-size: 11px;
    color: var(--skrive-muted);
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    min-height: 1.5rem;
  }

  .rename-count-pending {
    opacity: 0.7;
  }

  .rename-count-sep {
    opacity: 0.5;
  }

  .rename-count-self {
    font-style: italic;
  }

  .rename-preview {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    border-top: 1px solid var(--skrive-rule);
    border-bottom: 1px solid var(--skrive-rule);
  }

  .rename-empty {
    margin: 0;
    padding: 0.75rem 0.875rem;
    font-size: 12px;
    color: var(--skrive-muted);
  }

  .rename-rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .rename-row {
    display: grid;
    grid-template-columns: 5rem 1fr;
    gap: 0.125rem 0.5rem;
    padding: 0.4rem 0.875rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
  }

  .rename-row + .rename-row {
    border-top: 1px dashed var(--skrive-rule);
  }

  .rename-row-kind {
    color: var(--skrive-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    align-self: center;
  }

  .rename-row-path {
    color: var(--skrive-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rename-row-line {
    color: var(--skrive-muted);
    margin-left: 0.1em;
  }

  .rename-row-self-badge {
    margin-left: 0.5em;
    padding: 0.05em 0.3em;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--skrive-muted);
    background: var(--skrive-rule);
    border-radius: 2px;
  }

  .rename-row-snippet {
    grid-column: 2;
    color: var(--skrive-muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rename-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
  }

  .rename-button {
    background: transparent;
    border: 1px solid var(--skrive-rule);
    border-radius: 3px;
    color: var(--skrive-fg);
    font: inherit;
    font-size: 12px;
    padding: 0.4rem 0.9rem;
    cursor: pointer;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .rename-button:hover:not(:disabled) {
    border-color: var(--skrive-fg);
  }

  .rename-button-commit:not(:disabled) {
    background: var(--skrive-fg);
    color: var(--skrive-bg);
    border-color: var(--skrive-fg);
  }

  .rename-button-commit:not(:disabled):hover {
    opacity: 0.85;
  }

  .rename-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
