<script lang="ts">
  import Editor from "$lib/editor/Editor.svelte";

  // Hardcoded sample document for Phase 1.2. Phase 2 wires this up to
  // `open_project` / `read_file` and the user gets to pick their own project.
  let value = $state(`---
title: Welcome to Skrive
tags: [phase-1, scaffold]
---

# Skrive

A Markdown IDE for people who write seriously and ship to the web.

## Try it

Type into this document. Every keystroke goes through CodeMirror's transaction
system — there is no other path. The Rust core watches the project directory
and emits events when files change on disk.

- **Files are the source of truth.** Plain Markdown with YAML frontmatter.
- **No network calls** beyond user-initiated exports.
- **One default theme** done well before a theme system exists.

> Write seriously.
`);
</script>

<main>
  <header>
    <span class="brand">Skrive</span>
    <span class="status">phase 1 — foundation</span>
  </header>
  <div class="editor">
    <Editor bind:value />
  </div>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0.75rem 1.5rem;
    border-bottom: 1px solid var(--skrive-rule);
    flex-shrink: 0;
  }

  .brand {
    font-weight: 600;
    letter-spacing: -0.01em;
    font-size: 0.95rem;
  }

  .status {
    font-size: 0.75rem;
    color: var(--skrive-muted);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .editor {
    flex: 1;
    min-height: 0;
  }
</style>
