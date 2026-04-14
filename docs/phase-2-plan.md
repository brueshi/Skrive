# Phase 2 Plan

The actionable next-session plan. Where [`roadmap.md`](roadmap.md) shows the full sequence and [`critical-path.md`](critical-path.md) explains *why*, this document is the *what to do next*.

Phase 2 in the build outline has four sub-phases (2.1 split view, 2.2 inline preview, 2.3 frontmatter system, 2.4 spellcheck). This plan covers steps through 2.2 — once 2.2 is proven, we'll write the next plan for 2.3 and 2.4.

## Pre-flight checklist

All three blocking questions resolved — see [`open-questions.md`](open-questions.md#resolved).

- [x] **A1** — Hideable sidebar, default visible on first launch, `⌘B` toggle
- [x] **A2** — **Tabs.** Multiple open files at once. Tab bar lands in Step 2; the project store shapes around tabs from Step 1.
- [x] **A3** — Three-tier state model. `.skrive.toml` for shared config, platform app data for per-project personal state and app-wide state. No `.skrive/` folder inside the project.

The tabs decision changes Step 1's shape slightly: the project store uses `tabs: Tab[]` + `activeTabIndex`, not `currentFile`. Step 1 does not build the tab-bar UI — the debug file list doubles as tab switcher for now. Step 2 builds the real tab bar with icons.

## Step 1 — File dialog plumbing

**Status.** Done. Shipped in `8dbd5ac` and `d126311`.

**Goal.** Replace the hardcoded sample document with a real "Open project…" flow.

**Why first.** Without this, nothing else in Phase 2 can be tested against real projects. It's also the smallest possible useful change after Phase 1.

**Deliverables.**
- Add `tauri-plugin-dialog` to `Cargo.toml` and `src-tauri/src/lib.rs`
- Add the dialog plugin to capabilities in `src-tauri/capabilities/default.json`
- Add a frontend wrapper in `src/lib/dialog.ts` that opens a directory picker and returns the chosen path
- Replace the sample-doc page with a "Open project" button when no project is loaded
- On project open, call `open_project(path)` from the Rust core, store the manifest in a Svelte store
- Render the file list in a temporary debug sidebar (we'll style it properly in Step 2)
- Click a file → call `read_file(path)` → load into the editor via the existing `value` prop

**Files touched.**
- `src-tauri/Cargo.toml` — add `tauri-plugin-dialog = "2"`
- `src-tauri/src/lib.rs` — register the plugin
- `src-tauri/capabilities/default.json` — add `dialog:default`
- `src/lib/dialog.ts` — new (thin wrapper around the dialog plugin)
- `src/lib/stores/project.svelte.ts` — new (Svelte 5 rune store for the current project + open file)
- `src/routes/+page.svelte` — restructure to use the project store
- `src/lib/components/EmptyState.svelte` — new ("Open project" button when nothing is loaded)

**Success criteria.**
- Click "Open project", choose a directory, see the file list populate
- Click any markdown file in the list, see it load into the editor
- Editing the file updates the editor surface (we don't save yet — that's Step 2)
- Switching files preserves edits in memory (also Step 2 — for now, switching loses unsaved edits)
- The watcher fires events when files change on disk (we don't react to them yet — Step 2)

**Estimated complexity.** Small. Maybe a day.

---

## Step 2 — Phase 2.1 split view layout

**Status.** Done. The three-mode surface, real sidebar, header, tab bar, auto-save, watcher reload, and per-project UI state persistence are all in place. Deferred for later: cursor/scroll persistence, sidebar drag-resize, and the `preferences.svelte.ts` app-wide store with recent-projects history.

**Goal.** Build the three-mode editor surface (raw / split / preview), wire it up properly with a real sidebar, persist state, and handle saving.

**Deliverables.**

*Layout itself.*
- A left sidebar with the file list (hideable, default visible, ⌘B to toggle)
- A header bar with current file name, save indicator, and layout-mode toggle
- The editor surface in three modes:
  - **Raw** — `Editor.svelte` only
  - **Split** — `Editor.svelte` + `Preview.svelte` side by side, drag-resizable divider
  - **Preview** — `Preview.svelte` only
- Keyboard shortcuts: ⌘1 raw / ⌘2 split / ⌘3 preview
- Layout state persisted per file in `.skrive/state.json`

*Preview component.*
- A new `src/lib/preview/Preview.svelte` that renders the current document body
- For Step 2 we use a basic `marked` or `unified` pipeline — not the inline preview decorations from Phase 2.2
- Preview is read-only, follows scroll position roughly synced to the editor (rough is fine)

*Save and watcher.*
- Auto-save on a debounce (1-second after the last keystroke) via `write_file`
- Listen to `project://file-changed` events from the Rust watcher
- If a watcher event arrives for the currently open file and the change wasn't ours, prompt to reload (or auto-reload if there are no unsaved edits)
- "Recently opened files" history kept in app-wide preferences (the global prefs store)

*Sidebar polish.*
- File list sorted alphabetically with directory grouping
- Currently open file highlighted
- Click outside the file list area dismisses any contextual UI

**Files touched.**
- `src-tauri/Cargo.toml` — possibly nothing new (we already have `notify` from Phase 1)
- `src/lib/preview/Preview.svelte` — new
- `src/lib/preview/markdown.ts` — new (configures the markdown pipeline)
- `src/lib/components/Sidebar.svelte` — new
- `src/lib/components/Header.svelte` — new
- `src/lib/components/SplitView.svelte` — new (the three-mode layout itself)
- `src/lib/stores/project.svelte.ts` — extended with current file, dirty state, layout mode
- `src/lib/stores/preferences.svelte.ts` — new (app-wide prefs in platform app data)
- `src/lib/persistence/skrive-dir.ts` — new (read/write `.skrive/state.json`)
- `src/routes/+page.svelte` — composed from the new components
- `package.json` — add `marked` or `unified` + remark plugins (deciding which when we get there)

**Success criteria.**
- Open a project, click a file, see it in raw mode
- Press ⌘2, see the split view with rendered preview
- Drag the divider, resize works smoothly, no layout shift
- Press ⌘3, see preview only
- Switch to a different file, layout mode is restored from the previous time you viewed *that file*
- Edit a file, watch it auto-save after a brief pause
- Edit the file externally (in another editor), watch the file-change banner appear

**Estimated complexity.** Medium. Maybe a week and change.

**Hidden complexity to flag.**
- Drag-resizable splitters with persisted position are surprisingly fiddly
- Saving + watcher creates a feedback loop (we save → watcher fires → frontend thinks the file changed externally) — need to suppress watcher events for our own writes by tracking a "recently saved" timestamp
- Layout persistence has to handle files being deleted from the project gracefully

---

## Step 3 — Phase 2.2 inline preview spike

**Status.** Done. All three questions answered yes on `spike/phase-2.2-decorations`. See [`spike-2.2-report.md`](spike-2.2-report.md). Go decision recorded; Step 4 is unblocked.

**Goal.** Prove the technical feasibility of inline previews via CodeMirror decorations *before* committing to the full implementation.

**This is a throwaway.** Code written here is not expected to ship. The goal is a yes/no answer to three questions.

**The three questions.**

1. **Can a CM6 widget decoration render an inline image inside a markdown line?** Implementation: detect `![alt](path)` syntax via a `ViewPlugin` that scans visible ranges, replace each match with a `WidgetType` that renders an `<img>` element, and verify it survives editing the surrounding text.

2. **Can a fold decoration collapse `**bold**` to just `**bold**` (rendered) when the cursor leaves the line?** Implementation: a separate `ViewPlugin` that watches `EditorSelection` changes, finds emphasis spans on lines without the cursor, and applies replace decorations that hide the `**` markers while keeping the inner text styled.

3. **Can the fold restore when the cursor returns to that line?** Same plugin, inverse condition. Test that no flicker occurs and that the cursor placement after restoration is sensible.

**Deliverables.**
- A new branch `spike/phase-2.2-decorations` (do not merge into `main` unless the spike succeeds)
- One file: `src/lib/editor/spike/decorations.ts` containing both ViewPlugins
- Mounted on a hardcoded sample document (do not touch the real Editor.svelte)
- A short report in `docs/spike-2.2-report.md` answering each of the three questions with yes / no / partial, plus notes on what broke

**Success criteria.** All three questions answered yes. If any answer is no, see "Failure response" in [`critical-path.md`](critical-path.md#2-phase-22--inline-preview-decorations).

**Estimated complexity.** 1–2 days.

**Gating decision.** This spike gates Step 4. If it fails, we stop and have the failure-response conversation before writing any more Phase 2 code.

---

## Step 4 — Phase 2.2 inline preview implementation

**Goal.** Build the full inline preview system based on what the spike learned.

**This step is conditional on Step 3 succeeding.** The deliverables and complexity estimate below are *if* the spike works as expected. If the spike forces a rearchitecture, this section gets rewritten.

**Deliverables.**
- A real `src/lib/editor/decorations/` directory containing:
  - `images.ts` — inline image rendering
  - `emphasis.ts` — fold-on-cursor-leave for `**bold**`, `*italic*`, `~~strikethrough~~`
  - `links.ts` — `[text](url)` displayed as styled text with URL hidden
  - `code.ts` — inline code spans with backticks hidden when not active
  - `headings.ts` — heading prefix (`#`, `##`) hidden when not on the line
  - `index.ts` — exports a single `inlinePreview()` extension factory
- Wire `inlinePreview()` into `Editor.svelte`'s extension list
- Math (`$...$` and `$$...$$`) is *deferred* to Phase 2.2.5 to keep the initial scope manageable — KaTeX is its own can of worms

**Success criteria.** All the bullets in [`critical-path.md`](critical-path.md#2-phase-22--inline-preview-decorations) "What success looks like" pass on a real document with mixed content.

**Estimated complexity.** Large. Two to four weeks depending on how many edge cases the spike surfaces.

---

## After Phase 2.2

Once Step 4 is shippable, we write the Phase 2.3 + 2.4 plan and the Phase 3 plan. At that point we should also:

- Record an internal demo video of the inline preview working — even if it never leaves the team, it's the first piece of "is this product real" evidence
- Re-evaluate the roadmap based on what we learned
- Update [`open-questions.md`](open-questions.md) with whatever new questions Phase 2 surfaced

---

## What's deliberately not in Phase 2

To keep scope honest, here's what is *not* in this plan, even though they're tempting:

- **Frontmatter UI.** That's Phase 2.3, after the inline preview is proven.
- **Spellcheck.** Phase 2.4. Easy to underestimate but easy to defer.
- **The link graph commands.** Those are Phase 3.1. The graph is built; commands wait.
- **Lint.** Phase 3.2.
- **Importers, exporters, license, anything in Phase 4–7.**
- **Theme variants, font picker, custom keybindings.** Phase 6.

If any of these creep in during Phase 2 work, push back and add them to the relevant phase plan instead.
