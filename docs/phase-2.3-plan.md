# Phase 2.3 Plan — Frontmatter System

The next-session plan for Phase 2.3. Phase 2.2 (inline preview decorations) has shipped; [`phase-2-plan.md`](phase-2-plan.md) covered phases 2.1 and 2.2 and is now history.

Phase 2.3 turns frontmatter from "an opaque YAML block at the top of the file" into a first-class editing surface. Per the build outline, it is a *structured subsystem*, not raw YAML in the editor. Most of the Rust-side plumbing already exists from Phase 1 — this phase is largely about exposing it, fixing the round-trip gap that Phase 2 work missed, and adding the UI.

## Pre-flight checklist — what already exists

- [x] `src-tauri/src/frontmatter.rs` parses YAML into a `Map<String, Value>` with full test coverage.
- [x] `project::scan` parses frontmatter from every file during `open_project`. Every `FileEntry` in the manifest carries a `frontmatter` payload.
- [x] `FileContent` (the `read_file` return type) carries the parsed frontmatter alongside the stripped body.
- [x] Frontend `FileEntry` and `FileContent` types mirror the Rust shapes in `src/lib/types.ts`.
- [x] `Tab.content.frontmatter` is present in the store but currently unused by any UI code.

## Pre-existing gap Phase 2.3 must fix

**`write_file` does not preserve frontmatter.** Today the Rust `write_file` command takes `{ path, content: String }` and writes the string verbatim. The frontend's autosave path sends only the editor's body (which is already stripped of the `---` block by `read_file`). The net effect: **saving any file with frontmatter destroys the frontmatter block on the first write**. Nothing in Phase 2.1 or 2.2 exercised this path, so the bug has been silent.

Round-trip preservation is therefore Step 1. Nothing else in Phase 2.3 can land on top of a data-destroyer.

## Key decisions

1. **Panel visibility — orthogonal tool, not docked chrome.** The frontmatter panel is invoked via a header indicator and a keyboard shortcut (⌘⇧F), not pinned above the editor. When closed the only cost is a small header indicator like `FM · 4` that doubles as a health signal for future lint warnings. When open the panel is a floating compact surface anchored to the indicator; Escape or click-outside dismisses it. This keeps the three layout modes (⌘1 / ⌘2 / ⌘3) about the editor surface, treats frontmatter as a *document property* rather than an editor mode, and costs zero vertical chrome in any layout. Accessible from every mode via the same shortcut.
2. **Type-preserving edits on commit.** On display the panel stringifies each value using simple rules (scalars as-is, arrays as editable chip lists). On blur or Enter the new text is re-parsed using the *original value type as a hint*: boolean fields coerce `"true"`/`"false"` back to bool, number fields parse numeric strings, arrays stay arrays through the chip input. Fields whose original type was string stay string. New fields default to string because there's no way to disambiguate intent from text alone. This prevents silent type corruption that would break downstream YAML consumers (Astro, Hugo, Docusaurus).
3. **Array values — chip input, not comma-separated text.** Each array element is its own editable chip. Click to edit inline, backspace on an empty chip to delete, Enter or comma to commit a new chip. This is the one per-type editor Skrive v1 ships because commas-in-values (`authors: ["Last, First"]`) is a real and common pattern that comma-split text silently destroys. Everything else (date pickers, boolean toggles, color swatches) stays as plain text.
4. **Schema inference — approach (1), inline in `open_project`.** The Rust scan already walks every file and parses its frontmatter; the schema aggregation is a second pass over the already-parsed data, essentially free. The frontend caches the result in the project store, and autocomplete reads from the cache — no Rust IPC per keystroke. Staleness within a session is accepted for v1; the wire protocol is designed so incremental updates can be added later without reshaping the UI.
5. **Auto-updating fields — present-only update.** `last_modified`, `word_count`, `reading_time` are stamped on save *only if the field already exists* in the file's frontmatter. Skrive does not insert these fields into files that don't have them. This respects prose files that the user wants to stay clean and matches the "inference, not enforcement" philosophy.
6. **Animation vocabulary.** Panel open/close uses a 180ms slide-plus-fade on the existing `--skrive-ease-mechanical` curve (`cubic-bezier(0.4, 0, 0.2, 1)`). Technique: `grid-template-rows: 0fr → 1fr` on a wrapper with `overflow: hidden`, layered with an opacity fade on the inner content. This animates actual rendered height against auto-sized content, which a `max-height` transition cannot. Editorial, not bouncy.
7. **New file, not extending `phase-2-plan.md`.** Each phase plan is self-contained; Phase 2 history stays clean.

---

## Step 1 — Round-trip frontmatter preservation

**Status.** Done. `frontmatter::serialize` shipped with unit tests; `write_file` now takes `{ path, body, frontmatter }`; autosave captures `tab.content.frontmatter` alongside the body at schedule time.

**Goal.** Writing a file preserves its frontmatter block. This is the load-bearing fix; nothing else in Phase 2.3 can land until it does.

**Why first.** Current behavior silently destroys frontmatter. Every subsequent step assumes the frontmatter in the tab store can be written back.

**Deliverables.**
- Rust `frontmatter::serialize(&Map<String, Value>) -> String` that emits a YAML block suitable for concatenation with a body, including the leading `---\n` and trailing `---\n`. Deterministic key order (insertion order via `preserve_order` or alphabetical — pick whichever is cheapest).
- `project::write` changes signature to `write(root, rel, body, frontmatter)` and handles the concatenation.
- `commands::write_file` changes signature from `{ path, content }` to `{ path, body, frontmatter }`.
- `src/lib/persistence/autosave.ts` passes `tab.content.frontmatter` alongside the body.
- `src/routes/+page.svelte` `handleChange` still only updates the body (the user is editing the body in the CodeMirror surface; frontmatter mutations come through the panel).

**Files touched.**
- `src-tauri/src/frontmatter.rs` — new `serialize()` with unit tests for empty map, scalar values, array values, nested values, round-trip against `parse()`.
- `src-tauri/src/project.rs` — `write()` signature change.
- `src-tauri/src/commands.rs` — `write_file` signature change.
- `src-tauri/Cargo.toml` — possibly enable `serde_json/preserve_order` if we want insertion-order keys.
- `src/lib/persistence/autosave.ts` — pass `body` and `frontmatter`.

**Success criteria.**
- Create a file with `--- \ntitle: Hello\ntags: [a, b]\n--- \n# Body\n`. Open it, edit the body, save. Read the file back from disk and verify the frontmatter block is byte-identical (modulo key order if we didn't enable preserve_order).
- Create a file with no frontmatter, edit the body, save. Verify no `---` block is added.
- Create a file with empty frontmatter (`---\n---\n# Body\n`), edit the body, save. Verify the empty fence is preserved.
- The existing Phase 2.1 auto-save path (debounce + watcher suppression) continues to work unchanged.

**Estimated complexity.** Small. Half a day.

---

## Step 2 — Auto-updating fields

**Status.** Done. `src/lib/persistence/autoFields.ts` with `computeWordCount`, `computeReadingTime`, and `stampAutoFields`; the auto-save driver calls `stampAutoFields` inside `writeNow` so mutations flow through the tab store by reference.

**Goal.** `last_modified`, `word_count`, and `reading_time` stay accurate on every save — but only for files that have already opted in by including those fields in their frontmatter.

**Why second.** It's the smallest feature on top of the round-trip pipeline, and getting it working end to end validates that Step 1 actually preserves frontmatter across the full save loop.

**Deliverables.**
- A new `src/lib/persistence/autoFields.ts` module with:
  - `computeWordCount(body: string): number` — split on whitespace, filter empty tokens, length
  - `computeReadingTime(wordCount: number): number` — `Math.max(1, Math.round(wordCount / 200))` (minutes, Medium's 200 wpm convention)
  - `stampAutoFields(frontmatter: Map, body: string): Map` — mutates the three fields in place *only if they already exist as keys*; returns the same reference for convenience
- `autosave.ts` calls `stampAutoFields(tab.content.frontmatter, next)` before invoking `write_file`.
- `last_modified` is serialized as an ISO 8601 string (`new Date().toISOString()`).

**Files touched.**
- `src/lib/persistence/autoFields.ts` — new.
- `src/lib/persistence/autosave.ts` — invoke `stampAutoFields` in the debounced flush.

**Success criteria.**
- File with `last_modified: 2024-01-01T00:00:00.000Z` in its frontmatter: edit body, wait for auto-save, file on disk has an updated ISO timestamp.
- File without `last_modified`: edit body, save, no new field is added.
- `word_count` reflects the body length within ±1 of manual word count for typical prose.
- `reading_time` rounds up from `word_count / 200` and never drops below 1.

**Estimated complexity.** Trivial. A couple of hours.

---

## Step 3 — Schema inference (Rust + frontend cache)

**Status.** Done. `ProjectSchema` and `FieldInfo` types live in `src-tauri/src/project.rs` with seven unit tests covering presence counts, boolean enum detection, threshold clearing, arrays, mixed types, non-scalar poisoning, and empty inputs. Schema travels on `ProjectManifest` and is exposed via a `project.schema` getter on the frontend store.

**Goal.** The Rust core emits a `ProjectSchema` describing every frontmatter field seen across the project. The frontend caches it in the project store and the autocomplete system reads from the cache.

**Why third.** The panel UI (Step 4) and autocomplete (Step 5) both consume the schema. Building it before the UI means those steps start with a concrete data source instead of a mock.

**Deliverables.**

*Rust side.*
- New `frontmatter::infer_schema(files: &[FileEntry]) -> ProjectSchema` function.
- New serde types:
  ```rust
  pub struct ProjectSchema {
      pub file_count: usize,
      pub fields: BTreeMap<String, FieldInfo>,
  }
  pub struct FieldInfo {
      pub presence: usize,
      pub types: Vec<String>,          // distinct value types seen: "string" | "array" | "number" | "boolean" | "object" | "null"
      pub known_values: Vec<Value>,    // populated only for small-enum-like fields
  }
  ```
- "Small-enum-like" heuristic: if every value the field holds across the project is a scalar (string / number / boolean) AND the count of distinct values is ≤ 20, populate `known_values` with the distinct set. Otherwise leave it empty.
- `open_project` returns the schema alongside the manifest in a new payload shape:
  ```rust
  pub struct ProjectOpenResult {
      pub manifest: ProjectManifest,
      pub schema: ProjectSchema,
  }
  ```
  (or we add `schema: ProjectSchema` as a sibling field on the existing `ProjectManifest` — cleaner for the frontend, small migration cost).

*Frontend side.*
- `src/lib/types.ts` gains `ProjectSchema` and `FieldInfo` mirrors.
- `src/lib/stores/project.svelte.ts` holds `schema: ProjectSchema | null` and refreshes it on `openProject`.
- Unit test in Rust for `infer_schema` against a synthetic file list covering: field present in some files, scalar enum-like detection, large value set (known_values empty), mixed types across files.

**Files touched.**
- `src-tauri/src/frontmatter.rs` — `infer_schema`, `ProjectSchema`, `FieldInfo`, plus tests.
- `src-tauri/src/project.rs` — add `schema` to the manifest return or introduce a new result type.
- `src-tauri/src/commands.rs` — `open_project` returns the new shape.
- `src/lib/types.ts` — schema types.
- `src/lib/stores/project.svelte.ts` — store the schema, expose via getter.

**Success criteria.**
- Open a project with 10+ files, verify the schema lists every field that appears in at least one file.
- A field that appears in 8 of 10 files has `presence: 8`.
- A `draft: true/false` field across files has `types: ["boolean"]` and `known_values: [true, false]`.
- A `title` field across files has `types: ["string"]` and `known_values: []` (too many distinct values).
- A `tags` field across files has `types: ["array"]` and `known_values: []` (arrays never populate known_values).

**Estimated complexity.** Small to medium. A day.

---

## Step 4 — Frontmatter panel UI

**Status.** Done. `FrontmatterPanel.svelte`, `FrontmatterChipInput.svelte`, and the `FM · N` header indicator are wired through `+page.svelte`. Stable per-row IDs underpin the `#each` so renames update `row.key` in place rather than remounting the row — Tab navigation between key and value inputs works, and rows don't jump position on commit. The panel mounts as a direct child of `<main>` so it overlays the workspace from the top-right with the 180ms grid-row + opacity-fade animation. Auto-extract on save, preview-strip in the markdown pipeline, and lenient Rust parsing all landed alongside this step to support the typed-frontmatter authoring path. `formatError()` replaces every `String(err)` site so Rust error objects no longer surface as `[object Object]`.

**Goal.** A header indicator plus a floating, invokable panel that shows and edits the current file's frontmatter. The panel is an *orthogonal tool*, not pinned chrome — no vertical space is spent when the user isn't actively editing frontmatter.

**Deliverables.**

*Header indicator.*
- `Header.svelte` gains a new indicator sitting to the left of the layout-mode toggle. Format: `FM · 4` when the active file has fields, `FM · +` when empty (meaning "no fields — click to start"). Muted until the pointer enters, then lifts to the foreground color on hover.
- Clicking the indicator toggles the panel. The indicator is also the anchor point for the floating panel's positioning so the panel appears visually attached to its invocation source.
- The indicator is only rendered when a file is active (`project.activeTab !== null`). Hidden otherwise.

*Floating panel component.*
- `src/lib/components/FrontmatterPanel.svelte`:
  - Positioned absolutely, anchored to the header indicator. Top-right of the viewport, offset slightly so it doesn't cover the indicator itself.
  - Width: ~32rem. Height: content-driven up to `40vh`; beyond that the inner rows scroll while the header/footer of the panel stay pinned.
  - Each row in the panel is a field: `key` input, `value` input (or chip group for array values), `×` button to remove the field.
  - Below the rows: a `+ Add field` button that appends an empty row and focuses the new key input.
  - Top of the panel: a small header showing the current file's relative path as a muted label so the user knows which file they're editing at a glance.
  - Escape and click-outside both dismiss. Focus returns to the editor on dismiss.

*Value rendering, per type.*
- **String, number, null, new fields** — plain `<input type="text">`. On commit, re-parse using the original type as a hint (numeric string → number if the original was number; otherwise keep as string).
- **Boolean** — plain text input showing `true` or `false`. On commit, coerce the literal strings `"true"` / `"false"` back to bool; any other text is stored as a string (type change is the user's choice and is explicit).
- **Array** — chip group. Each chip is an editable label with a small × on hover. Enter or comma commits a new chip; backspace on an empty input deletes the previous chip. Chip content is always string in v1 (number-of-chips is the data, chip contents are the labels).
- **Object** — read-only placeholder `<object>` with a disabled state. Editing nested objects is deferred — the body of the file or a later polish pass owns that.
- Values whose original type was `null` display as an empty input; typing something flips them to string on commit.

*Open/close animation.*
- Panel root uses `display: grid; grid-template-rows: 0fr` closed → `1fr` open, with a child wrapping the inner content in `overflow: hidden`. Transition: `grid-template-rows 180ms cubic-bezier(0.4, 0, 0.2, 1)`. The inner content has its own `opacity 180ms` fade layered on top so the reveal feels intentional rather than mechanical.
- Respect `prefers-reduced-motion`: reduce to an instant show/hide with no transition.

*Store changes.*
- `project.svelte.ts` exposes `frontmatterPanelOpen: boolean` as local session state (not persisted — the panel is a transient tool, not a layout preference). Actions: `openFrontmatterPanel()`, `closeFrontmatterPanel()`, `toggleFrontmatterPanel()`.
- Mutation actions that the panel calls: `updateActiveTabFrontmatter(key, value)`, `removeActiveTabFrontmatter(key)`, `renameActiveTabFrontmatterKey(oldKey, newKey)`. All mutate `tab.content.frontmatter` in place and flag the tab dirty. Autosave picks up the mutation because Step 1 now writes frontmatter through `write_file`.
- Key rename conflict: if the target key already exists on the file (and isn't the row's own key), the rename is silently reverted on blur. No modal.
- Empty key on blur: the row is discarded. No cruft.
- Field removal: no confirmation. One re-add is cheaper than a modal.

*Keyboard shortcut.*
- `⌘⇧F` toggles the panel. Wired in `+page.svelte` alongside the existing ⌘1/⌘2/⌘3/⌘B/⌘S shortcuts. When the panel is open, ⌘⇧F closes it (symmetric), and Escape also closes.

*Mode behavior.*
- The panel and its indicator are available in all three layout modes (raw, split, preview). The indicator is just a header button; it doesn't eat editor space in any mode. In preview-only mode the user can still open the panel to edit metadata without flipping back to raw.

**Files touched.**
- `src/lib/components/FrontmatterPanel.svelte` — new.
- `src/lib/components/FrontmatterChipInput.svelte` — new (extracted because chip editing has enough internal state to justify a component boundary; reusable if we later add chip inputs elsewhere).
- `src/lib/components/Header.svelte` — add the `FM · N` indicator.
- `src/routes/+page.svelte` — mount the panel as a direct child of `main` (not inside `.workspace`), wire ⌘⇧F, forward Escape from the panel.
- `src/lib/stores/project.svelte.ts` — panel open/close state, mutation actions.

**Success criteria.**
- Open a file with frontmatter: indicator shows `FM · N`. Press ⌘⇧F: panel animates open (180ms slide + fade), shows rows for each field, cursor lands on the first field's value input.
- Edit a value, press Tab: value commits with type preservation, cursor moves to next row's key.
- Press Escape: panel animates closed, focus returns to the editor surface.
- Open a file with no frontmatter: indicator shows `FM · +`. Press ⌘⇧F: panel opens with a "+ Add field" affordance; clicking it creates an empty row; filling in key + value saves the file *with* a newly-created frontmatter block.
- Edit a `tags` field that's an array: chip group renders, adding a chip with a comma in its content works (`Last, First`), the YAML round-trips correctly.
- Removing the last field from a file's frontmatter: the file is written without a `---` block on save.
- With `prefers-reduced-motion` set, the panel shows/hides instantly with no transition.

**Estimated complexity.** Medium. Two days — the chip input and the grid animation both eat half-days of polish.

---

## Step 5 — Autocomplete

**Status.** Done. `SuggestionList.svelte` is the dumb dropdown component (suggestions array + selected index in, pick / hover events out). `FrontmatterPanel.svelte` owns the suggestion state and computes candidates from `project.schema`: key suggestions exclude already-used field names and rank by descending presence; value suggestions read from `FieldInfo.knownValues`. Keyboard handling matches the plan exactly — ↓/↑ navigate, Enter or Tab accept, Escape dismisses the dropdown only (event propagation stopped so the panel root's Escape handler doesn't also close the panel). Click-to-pick works alongside, with `mousedown` `preventDefault` so the input doesn't blur before the pick registers.

**Goal.** Typing into a field key suggests known field names from the project schema. Typing into a field value suggests known values when the schema has a small enum-like set for that field.

**Deliverables.**
- A minimal suggestion dropdown anchored below the focused key or value input inside the floating panel.
- Keyboard: ↓/↑ to navigate, Enter or Tab to accept, Esc to dismiss the dropdown (not the panel — one Escape at a time).
- Suggestions for keys: schema field names not already present on this file, filtered by the current input.
- Suggestions for values: `FieldInfo.knownValues` for the corresponding key, filtered by the current input. Arrays (chip inputs) and objects never get suggestions.
- No fuzzy matching for v1 — prefix matching is enough. Fuzzy arrives with command-palette-style search in a later phase.

**Files touched.**
- `src/lib/components/FrontmatterPanel.svelte` — the suggestion UI.
- Possibly a small `src/lib/components/SuggestionList.svelte` if the component needs to be reusable later (Phase 3.1 link graph commands may want it).

**Success criteria.**
- New field row, type `ti` → dropdown shows `title`. Press Enter → key becomes `title`, focus moves to value input.
- `draft` field in a project where the schema has seen `true` and `false` → focusing the value input with no characters typed shows both options; typing `t` filters to `true`.
- `title` field, focus value input → no dropdown (no `known_values` because the set is too large to enumerate).
- `tags` field, focus value input → no dropdown (arrays excluded).

**Estimated complexity.** Small. Half a day to a day.

---

## After Phase 2.3

Phase 2.4 (spellcheck) comes next, followed by Phase 3.1 (link graph commands). At that point we should also:

- Revisit whether schema inference needs the watcher-triggered recompute described as "approach (2)" in the scalability discussion — only if the evidence says so.
- Decide whether `.skrive.toml` should carry an explicit frontmatter schema (required fields, type assertions, enum declarations). For v1 we rely entirely on inference.
- Record a short demo of the panel for the internal demo reel.

## What's deliberately not in Phase 2.3

To keep scope honest, here's what is *not* in this plan:

- **`.skrive.toml` schema authoring.** Inference only for v1.
- **Per-type editors beyond chip inputs for arrays** (date picker, boolean toggle, color swatch for hex values, number spinner). Plain text elsewhere. Arrays get the chip treatment in v1 because commas-in-values is a real and common data-integrity issue that text inputs silently destroy; every other type is polish.
- **Validation warnings** for missing required fields or type mismatches. That's Phase 3.2 lint territory.
- **Frontmatter-value navigation** (click a tag → filter to files with that tag). Phase 3.1 link graph commands.
- **Field reordering via drag**. Insertion order is whatever the YAML file has.
- **Multi-line value editing**. Single-line inputs. Use the body for anything long.
- **Watcher-triggered schema recompute.** Open-time only.
- **Incremental schema index with reverse lookups.** Approach (1) only.
- **Persisting panel open-state across sessions.** The panel is a transient tool, not a layout preference — it always opens closed. If a project needs the panel constantly open, that's a signal we should rethink the indicator rather than bolt on persistence.

If any of these creep in during Phase 2.3 work, push back and add them to Phase 3.2 or the polish phase instead.
