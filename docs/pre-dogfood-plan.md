# Pre-Dogfood Plan

The actionable plan for the hardening work that gates dogfooding in Step 0c of [`phase-3-plan.md`](phase-3-plan.md). Six items that make Skrive usable enough for serious daily use on real content.

This is not new features — it's the basic file-management and navigation affordances a user expects on day one of any editor. We deferred them from Phase 2 because the critical-path work came first. Now they block dogfooding.

## Why this is its own plan

1. The six items don't all ship together — some can land in parallel, some serially.
2. Two of them (open-with, in-project search) introduce real Rust surface area that deserves its own design section.
3. The right-click context menu framework gets reused by Phase 3.1 rename, so documenting it once here is cheaper than re-deriving it in 3.1.
4. The Phase 3 umbrella stays focused on Phase 3 proper. This plan stays focused on dogfood-readiness.

## Pre-flight — what already exists

- [x] `create_file` and `create_directory` Tauri commands (`src-tauri/src/commands.rs`). `create_directory` is only wired to project creation in `EmptyState.svelte`; the sidebar doesn't use it.
- [x] Watcher fires on file creation / deletion (`src-tauri/src/watcher.rs`). Sidebar refresh already falls out of watcher events.
- [x] `AppUiState` (`src-tauri/src/persistence.rs`) is the right home for app-wide preferences like "don't ask again for delete."
- [x] Project manifest exposes the full file tree to the frontend — enough for a command palette without new Rust work.
- [x] Floating-panel UI patterns (frontmatter, dictionary) to model the command palette and search modals after.

## Decisions already settled

Recorded here because they shape the step-level work below.

1. **OS trash, not permanent delete.** Via the `trash` crate (cross-platform Rust).
2. **Modal confirmation with a "don't ask again" checkbox.** Persisted in `AppUiState.skip_delete_confirmation`. The modal exists for undo-reduction, not "are you sure" — the operation is recoverable either way.
3. **Right-click context menu + Delete key.** Cmd-Backspace is the Mac-idiomatic alias.
4. **Dirty-tab cleanup on delete: drop, don't prompt.** OS trash is the safety net.
5. **Dead-link warnings after delete are deferred to Phase 3.2.** The lint engine owns the warning surface.
6. **Command palette v0 is a file switcher, not a command runner.** Running commands by name is a later pass.
7. **Search v0 is content-only, plain-text, case-insensitive by toggle.** Regex and filename search come later. Filename search is already what the command palette does.
8. **Search results: modal that stays open while typing, closes when a result is picked.** A pinned side panel is a later upgrade once dogfooding proves it's needed.
9. **Open-with auto-detects projects** by walking up from the opened file's path, looking for `.skrive.toml` or `.git`. Found → use as project root. Not found → use the file's parent dir as an ad-hoc project. This resolves [open question P2](open-questions.md#p2-what-does-skrive-look-like-with-no-project-open).
10. **Move file / folder is deferred.** Dogfooding will tell us if it's needed.

---

## Step 1 — Sidebar context menu + delete + folder create

**Goal.** The sidebar becomes a real file-management surface: right-click any row for a menu, create folders from the top toolbar, delete files and folders with recoverable confirmation.

**Why first.** Three items share the context-menu component, and the menu is the reusable piece Phase 3.1 rename will sit on top of. Landing them together avoids writing one-off buttons that get ripped out.

**Deliverables.**

*Context menu framework.*
- `src/lib/components/ContextMenu.svelte` — new. Takes an anchor position, a list of `{label, shortcut?, onClick, variant?}` items, and a dismiss handler. Escape and click-outside dismiss. Arrow-key navigation + Enter to activate.

*Delete (Rust).*
- `src-tauri/Cargo.toml` — add `trash` crate.
- `src-tauri/src/commands.rs` — `delete_path(path: String) -> Result<()>`. Canonicalizes, confirms the path is inside the project root (same guard as `write_file`), calls `trash::delete`. Works for files and directories.
- `src-tauri/src/persistence.rs` — extend `AppUiState` with `skip_delete_confirmation: bool` (serde default false).

*Folder create (UI).*
- `src/lib/components/Sidebar.svelte` — the top `+` button becomes a small menu (New file / New folder). New-folder naming reuses the existing inline-input pattern.

*Delete (UI).*
- `src/lib/components/DeleteConfirmModal.svelte` — new. Shows the name, a "Move to trash" primary button, Cancel, and a "Don't ask again" checkbox.
- Right-click on a sidebar row → menu → "Delete…" → modal (skipped if user previously checked "don't ask again").
- Delete key and Cmd-Backspace on the focused row do the same.
- Deleting an open file closes its tab silently.

*Store methods.*
- `src/lib/stores/project.svelte.ts` — `deleteFile`, `deleteDirectory`, `createDirectory`. Sidebar refresh comes from the watcher; no explicit re-scan.
- `src/lib/stores/preferences.svelte.ts` — `skipDeleteConfirmation`, wired through the existing load/save app-state path.

**Files touched.**
- `src-tauri/Cargo.toml`, `src-tauri/src/commands.rs`, `src-tauri/src/persistence.rs`
- `src/lib/components/ContextMenu.svelte` (new), `DeleteConfirmModal.svelte` (new), `Sidebar.svelte`
- `src/lib/stores/project.svelte.ts`, `preferences.svelte.ts`
- `src/lib/types.ts` — AppUiState mirror

**Success criteria.**
- Right-click a file → menu appears → "Delete…" → modal → confirm → file is in OS trash.
- Check "don't ask again"; next delete skips the modal.
- Delete key on a focused row triggers the same flow.
- Deleting an open file silently closes its tab.
- `+` menu lets you create a new folder; it appears in the sidebar.
- Deleting a non-empty folder trashes it and its children.

**Estimated complexity.** Medium. Two to three days, mostly UI polish.

---

## Step 2 — Command palette (⌘P file switcher)

**Goal.** Press `⌘P`, fuzzy-search across every file in the open project, Enter to open.

**Why second.** Navigation is the most-used affordance in an editor. The file manifest is already in memory so there's no Rust work — pure frontend.

**Deliverables.**
- `src/lib/components/CommandPalette.svelte` — new. Modal anchored top-center, similar visual weight to the existing floating panels but wider. Input at top, scrollable result list below.
- Matching: fuzzy, case-insensitive. Simple scoring — substring match, path-component-start bonus, consecutive-character bonus. If we need more sophistication later, pull in a small library.
- Empty query: show recently opened files. Add a recent-files list to `preferences.svelte.ts` if it isn't there yet (deferred from 2.1).
- Keyboard: ↑ / ↓, Enter, Esc. `⌘⇧P` is reserved for the future command-runner — note but don't wire.

**Files touched.**
- `src/lib/components/CommandPalette.svelte` (new)
- `src/lib/editor/fuzzy.ts` (new or inline)
- `src/lib/stores/preferences.svelte.ts` — recent-files
- `src/routes/+page.svelte` — mount, wire `⌘P`

**Success criteria.**
- `⌘P` opens the palette; empty state shows recent files.
- Typing filters results live; matches work across directory + filename.
- Enter opens the selected file; Esc dismisses.
- No visible lag on projects with hundreds of files.

**Estimated complexity.** Small to medium. One to two days.

---

## Step 3 — In-project search (⌘⇧F)

**Goal.** Press `⌘⇧F`, search across all project files with context snippets, click a match to jump there.

**Why third.** After file switching, "find where I wrote that thing" is the second-most-used navigation affordance. Unblocks dogfooding on anything larger than a few dozen files.

**Deliverables.**

*Rust side.*
- `src-tauri/src/commands.rs` — `search_project(root: String, query: String, options: SearchOptions) -> Result<Vec<SearchHit>>` with `SearchOptions { case_sensitive: bool }` and `SearchHit { path, line_number, column, snippet }`.
- Walk the project tree (reuse the `open_project` walker), read each file, scan line-by-line, skip binary files by extension. Naive scan is fine up to the sizes we'll dogfood on. Leave a TODO to swap in `grep-searcher` if it gets slow.
- Same project-root guard as `write_file` and `delete_path`.

*Frontend side.*
- `src/lib/components/SearchModal.svelte` — new. Same visual pattern as the command palette, wider to fit snippets. Results grouped by file with a header row per file; each result shows the line snippet with the match highlighted.
- Debounced query: fire `search_project` 150ms after the last keystroke.
- Click a result → open file at the matched line → close modal.

**Files touched.**
- `src-tauri/src/commands.rs`, `src-tauri/src/project.rs`
- `src/lib/components/SearchModal.svelte` (new)
- `src/routes/+page.svelte` — mount, wire `⌘⇧F`
- `src/lib/types.ts` — `SearchHit` mirror

**Success criteria.**
- `⌘⇧F` opens the modal.
- Type a word that appears in multiple files → results grouped by file with context.
- Click a result → file opens at the matched line.
- Binary files skipped silently.
- Search on this repo (~30 docs + source) returns within a few hundred ms.

**Estimated complexity.** Medium. Two to three days, mostly the results UI.

---

## Step 4 — Open-with-Skrive + P2 resolution

**Goal.** Double-clicking a `.md` file in Finder, Explorer, or a file manager opens it in Skrive. Skrive auto-detects the surrounding project. [P2](open-questions.md#p2-what-does-skrive-look-like-with-no-project-open) moves to Resolved.

**Why last.** Most platform-specific plumbing of the six items (Tauri config, Info.plist, Linux `.desktop` file, single-instance plugin). Landing it after the sidebar/nav work is in place means the "file opened from outside" flow has a real editor to drop the user into.

**Deliverables.**

*Config.*
- `src-tauri/tauri.conf.json` — register `.md` and `.markdown` file associations for macOS and Windows via Tauri v2's bundle config.
- Linux: `.desktop` file with `MimeType=text/markdown` in the bundle.
- `tauri-plugin-single-instance` so a second Skrive launch with a file path routes to the existing instance.

*Rust side.*
- `src-tauri/src/project.rs` — `resolve_project_for_file(file_path) -> (project_root, relative_file_path)`. Walks up from `file_path.parent()`, checking for `.skrive.toml` or `.git` at each step. If found, that dir is the root. If the walk hits filesystem root, the file's parent dir becomes the ad-hoc root.
- `src-tauri/src/commands.rs` — `open_file_path(path: String)`: resolves, calls `open_project`, emits an event with the file to focus.
- `src-tauri/src/lib.rs` — wire the file-open event. macOS uses `RunEvent::Opened`; Windows/Linux use command-line args handed to single-instance.

*Frontend side.*
- `src/routes/+page.svelte` — listen for the `open-file-path` event; load the resolved project and focus the file. If a different project is already open, quietly switch (dogfooding can flag if that's wrong).
- If the app launches with a file argument, skip the empty state entirely.

*Docs.*
- `open-questions.md` — move P2 to Resolved with a note citing this plan.

**Files touched.**
- `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`
- `src-tauri/src/project.rs`, `src-tauri/src/commands.rs`
- `src/routes/+page.svelte`
- `docs/open-questions.md`

**Success criteria.**
- macOS: right-click a `.md` file in Finder → Open With → Skrive → file opens, project auto-detected.
- Open a `.md` inside a `.git` repo: the git repo is the project.
- Open a `.md` in an arbitrary folder: parent dir is the ad-hoc project.
- Second Skrive launch with a file path doesn't spawn a duplicate.

**Estimated complexity.** Medium. Two to four days depending on Tauri plugin surprises and cross-platform testing.

---

## After pre-dogfood

Skrive is usable as a real editor on real content. Return to [`phase-3-plan.md`](phase-3-plan.md) Step 0c (dogfood week) — now actually actionable. Steps 0b (`.skrive.toml` schema) and 0d (3.3 algorithm memo) can run in parallel with the dogfood week.

---

## What's deliberately not in this plan

- **Rename-with-references** — Phase 3.1.
- **Move file / folder** — deferred; dogfooding decides.
- **Global search-and-replace** — too close to rename-with-references to ship ahead of it.
- **Command palette: run-by-name commands** — later pass.
- **Regex search** — later, after plain-text beds in.
- **Recent projects list, welcome screen** — [P1](open-questions.md#p1-single-file-or-multi-file-open-at-startup); later.
