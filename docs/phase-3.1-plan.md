# Phase 3.1 Plan — Link Graph Commands + Rename-with-References

**Status.** Draft. Full plan to be written when Phase 2.4 (spellcheck) ships. The design decisions below are recorded now so we don't relitigate them when we pick this work up — they were the open questions surfaced after Phase 2.3 and answered in conversation.

Phase 3.1 is largely *exposing* the link graph the Rust core already builds in Phase 1.4, plus the user-facing commands that act on it. The graph itself is built; we're surfacing rename-with-references, backlinks, and dead-link detection as commands and UI.

## Resolved design decisions

1. **Rename touches all three link styles.** Relative path links `[text](other.md)`, wiki links `[[other]]`, and reference-style links `[text][label]` with their separate `[label]: other.md` definitions all get rewritten when the target file is renamed. The current link graph parser only handles the first two; **extending it to track reference-style links is in scope for Phase 3.1**, not deferred. Reference-style support is non-trivial because the link definition can live in a different document section than its uses, but skipping it would silently mangle Hugo / Jekyll / older Markdown projects on rename.

2. **Preview-first confirmation flow.** Renaming is a heavy multi-file operation. Before committing, show a modal with "this will rename N references across M files", with a list of file paths. User confirms or cancels. No "just do it" mode in v1 — Cmd+Z across multiple files is hard to get right and the confirmation cost is small relative to the surprise cost.

3. **Backlinks as a floating panel.** The "what links to this file" surface follows the same orthogonal-tool pattern as the frontmatter panel: a header indicator (e.g. `BL · 3` for "3 backlinks"), invoked via a keyboard shortcut (`⌘⇧B`), dismissed via Escape or click-outside. Not pinned chrome. Not a sidebar section. Reasoning: backlinks are *contextual to the active file* and short-lived in a writing session, which matches the floating-tool ethos better than the persistent navigation ethos of the sidebar.

4. **Dead-link warnings live in the link graph.** When a target file is deleted or renamed without `rename-with-references`, the graph knows the dangling references exist. Phase 3.1 emits these warnings as data; **the warnings are *displayed* in Phase 3.2 (the lint engine)**. This keeps Phase 3.1 focused on the rename-and-reveal commands and lets lint own the unified warning surface.

5. **Demo each piece as we ship it.** Per build-outline, rename-with-references is one of the three Show-HN demo moments. We record short videos as the work lands, even if they stay internal. Cheap UX bug discovery + raw material for the launch demo.

## Open questions to revisit when writing the full plan

- Should the rename preview list also show the *line number* of each reference, or just the file path? Probably line + a short context snippet for the most common cases.
- What's the keyboard shortcut for invoking rename? `F2` (Windows convention) or `⌘R` (Mac convention) or something else? `⌘R` collides with browser reload and may be reserved by the webview.
- Backlinks panel: is `⌘⇧B` free? `⌘B` is already toggle-sidebar; `⌘⇧B` should be available.
- Does the rename command operate on the currently active file (rename *this file*), or on a clicked-on file in the sidebar (rename *that file*)? Probably both, but the trigger surfaces differ.

## Why Phase 3.1 isn't risky

The link graph is already built and tested in Phase 1.4. Reference-style link parsing is the only genuinely new code in the Rust core — and it's a parser extension, not an architecture change. The rest is UI work patterned after the frontmatter panel: a floating panel for backlinks, a confirmation modal for rename, plus a `rename_with_references` Tauri command that orchestrates the file writes through the existing path-confined `write` helper.

Estimated complexity: medium. Most of the time will be spent on the rename preview UX and reference-style link parsing, not on the underlying graph operations.

## Why Phase 3.3 is the next high-stakes spike after 3.1

Per `critical-path.md`, the structural diff is the second technical bet that could kill the product (after inline preview decorations). Same shape as the 2.2 spike: write a throwaway, prove the AST diff algorithm produces useful output on a small real-world example, then commit to the full implementation. Phase 3.3 builds on the link graph (links between files factor into the diff's "what moved" analysis), which is why 3.1 logically goes first.
