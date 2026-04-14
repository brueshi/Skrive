# Open Questions

A living list of decisions Skrive hasn't made yet. Each entry has a context, the options on the table, the current leaning, and the phase that will be blocked if we don't decide.

When a question is answered, move it to the **Resolved** section at the bottom with a short note on what we picked and why. Don't delete — the resolution history is useful later.

---

## Architecture

### A4. What's the schema for `.skrive.toml`?

**Context.** The build outline references `.skrive.toml` in two places: lint config (§3.2) and custom render targets (§5.2). It's never specified. Both phases will read this file, so we should write the schema once before either phase ships.

**Options.** Not really competing options — more a list of what the file needs to contain:

```toml
# .skrive.toml — sketch

[project]
name = "My Project"

[lint]
broken_internal_links = "error"
missing_required_frontmatter = "warn"
heading_hierarchy = "warn"
orphaned_files = "off"
duplicate_headings = "warn"

[lint.required_frontmatter]
fields = ["title", "date", "tags"]

[export.astro]
target_dir = "../my-astro-site/src/content"
frontmatter_map = { date = "pubDate" }

[export.custom.my_render]
template_dir = "./templates"
output_dir = "./dist"
```

**Leaning.** TOML, the structure above, and *every* section is optional — a project with no `.skrive.toml` works fine. We document the schema in `docs/skrive-toml-reference.md` once we ship it.

**Blocks.** Phases 3.2 and 5.2c/e.

**Status.** Open.

---

## Technical bets

### T1. What algorithm does structural diff use?

**Context.** Phase 3.3 needs to diff two ASTs of a Markdown document and render the changes as semantic operations. There are several real algorithms here. See [`critical-path.md`](critical-path.md#4-phase-33--structural-diff) for the longer discussion.

**Options.**
- **Block-hash matching with Hungarian fallback.** Fast, simple, good enough for most documents.
- **Tree edit distance (Zhang-Shasha).** Mathematically optimal but cubic in tree size.
- **Myers diff on flattened blocks.** Familiar but doesn't detect moves natively.

**Leaning.** Block-hash matching for v0.1. Benchmark against real documents. Escalate to tree edit distance for v1.0 only if needed.

**Blocks.** Phase 3.3.

**Status.** Open. Deserves a focused discussion before implementation.

---

### T2. What engine handles PDF export?

**Context.** Phase 5.2 ships PDF export with full typography control: font selection, margins, heading styles, code block themes, page numbering. The build outline explicitly says "Not a browser print stylesheet." That rules out Chromium-based approaches.

**Options.**
- **[Typst](https://typst.app/).** Rust, modern, beautiful output, growing ecosystem. We'd shell out to the `typst` binary or embed the library. Would require generating Typst markup from our AST. **My recommendation.**
- **[WeasyPrint](https://weasyprint.org/).** Python, mature, browser-like (CSS-based but not Chromium). Needs a Python runtime bundled or installed. Heavy.
- **[Printpdf](https://github.com/fschutt/printpdf) (pure Rust).** Low-level — we'd be drawing text and rectangles ourselves. Maximum control, maximum work.
- **[Tectonic](https://tectonic-typesetting.github.io/) (LaTeX).** Heavy dependency tree, slow first run, but produces beautiful output and people trust it.

**Leaning.** Typst. The output quality is excellent, it's actively developed, it's written in our stack's language, and the embedding story is improving. Worth a focused spike around Phase 4 to confirm.

**Blocks.** Phase 5.2a.

**Status.** Open. Spike planned for Phase 4 timeframe.

---

### T3. How do we handle the inline preview cursor / decoration ambiguity?

**Context.** Phase 2.2 builds inline previews via CodeMirror decorations. Cursor placement on rendered content (e.g., clicking on a rendered image) needs to be intuitive — but there's no obvious right answer.

**Options.**
- Clicking on a rendered image places the cursor at the start of the underlying `![alt](path)` syntax.
- Clicking on a rendered image places the cursor *after* the image, on the next character.
- Clicking on a rendered image puts the editor in a special "inspect" mode with a popover showing the alt text and path.

**Leaning.** Cursor at start of underlying syntax. Most predictable. Matches Typora's behavior.

**Blocks.** Phase 2.2.

**Status.** Open. Decide during the 2.2 spike.

---

## Product

### P1. Single-file or multi-file open at startup?

**Context.** When the user launches Skrive, what do they see? The last project they had open, the last *file* they had open inside that project, or a "welcome / pick a project" screen?

**Options.**
- **Restore last session.** Open the last project, focus the last file. Friction-free for daily users.
- **Welcome screen.** Always show a project picker on launch. Friction-free for first-time users.
- **Hybrid.** Welcome screen on first launch, restore last session afterward.

**Leaning.** Hybrid. Track this in app-wide preferences (see A3).

**Blocks.** Phase 6.2 (polish) — not blocking earlier work.

**Status.** Open.

---

### P2. What does Skrive look like with no project open?

**Context.** Edge case the build outline doesn't address. A user just installed Skrive, hasn't opened a project yet. What do they see?

**Options.**
- Empty editor with a centered "Open project" button.
- A welcome document that's actually a real Markdown file shipped with the app.
- A scratchpad mode — a single ephemeral document the user can write in without opening a project.

**Leaning.** Welcome document. Doubles as onboarding. Could use this very repo's `README.md` as a sample.

**Blocks.** Phase 6.2 — not blocking earlier work.

**Status.** Open.

---

## Monetization

### M1. How do we trace leaked license keys without a server?

**Context.** Phase 7 specifies local cryptographic license validation. No server. No phone home. This is non-negotiable per the build outline. But it means a leaked key cannot be revoked.

**Options.**
- **Embed purchaser email in the signed key payload.** A leaked key can be traced back to the purchase. Doesn't prevent piracy but creates social cost. The key payload is `{ email, purchase_id, version }` signed with our private key, verified with the public key embedded in the binary.
- **Hardware-fingerprint binding.** Key is bound to a machine fingerprint at first activation. Violates "no phone home" if we're not careful — and hardware fingerprints are user-hostile.
- **Accept piracy.** Charge $49 once, ship a key, accept that some keys will leak. Many indie dev tools do this and it works fine.

**Leaning.** Embed purchaser email in the key payload. It's the cheapest mitigation that doesn't compromise the "no network" principle. Pirated keys still work, but anyone sharing one is also sharing their email — that's enough friction to discourage casual sharing without needing enforcement.

**Blocks.** Phase 7.

**Status.** Open.

---

### M2. What's the upgrade story for users between v0.x betas and v1.0?

**Context.** We'll have private beta users on v0.5 before v1.0 ships. When v1.0 ships with the paid Pro tier, do beta users get a free Pro license? A discount? Nothing?

**Options.**
- Free Pro license forever for private beta users. Generous, builds goodwill, costs us nothing.
- 50% discount for private beta users. Still meaningful gesture, captures some revenue.
- Standard pricing with no acknowledgment. Cleanest, but ungrateful.

**Leaning.** Free Pro license for the first ~50 private beta users with a hand-issued key. After that, standard pricing.

**Blocks.** Phase 7. Not urgent.

**Status.** Open.

---

## Resolved

### A1. Where does the file-list sidebar live in the layout?

**Resolved 2026-04-14:** Hideable rail. Default to visible on first launch, persist the user's choice per-project. Keyboard shortcut `⌘B` to toggle.

**Original context.** Phase 2.1 needs a layout, and the user has to navigate files somehow. Options were permanent left rail, hideable rail, or command-palette-only. Hideable wins because it maximizes the writing surface without abandoning discoverability for new users.

---

### A2. What's the "open file" state model?

**Resolved 2026-04-14:** Tabs. Multiple files open at once, switched via a tab bar and keyboard shortcuts.

**Original context.** Options were single open file, tabs, or multiple windows. The initial lean was single-file with session history for focus, but the user chose tabs because serious writing sessions span multiple related files.

**Implications we're signing up for:**
- Tab bar UI (with close, dirty indicator, eventually reordering and overflow) — builds in Phase 2.1 Step 2, not Step 1
- Save prompts when closing dirty tabs (Step 2)
- Keyboard shortcut growth: `⌘W`, `⌘⇧T`, `⌘1`–`⌘9`, `⌘⌥←`, `⌘⌥→`
- The watcher needs to surface changes for every open tab, not just the active one
- Persistence restores the full tab set, not just one open file

The project store shapes around tabs from Step 1 so the foundation is right before the UI lands.

---

### A3. Where does per-file UI state get persisted?

**Resolved 2026-04-14:** Three-tier state model. No `.skrive/` folder inside the project.

- **Shared project config** (lint rules, export targets, frontmatter schema declarations) — `.skrive.toml` in the project root, committed to git, hand-edited by the user. Phase 3.2 ships the first real consumer.
- **Personal per-project state** (open tabs, cursor positions, scroll positions, layout mode per file, sidebar visibility and width) — platform app data, keyed by a hash of the canonicalized project path. File path: `{app_data_dir}/projects/{hash}.json`.
- **App-wide state** (recent projects, license key, last-opened project, first-run timestamp) — platform app data, single global file: `{app_data_dir}/app.json`.

**Rationale.** The more useful split is personal-vs-shared, not per-file-vs-app-wide. Two collaborators working on the same project (via git, Dropbox, etc.) get independent tab sets and cursor positions — no merge conflicts on cursor state. The user's project directory stays clean, with no tool-specific folder to add to `.gitignore`.

**Implementation plan.** Rust owns all state reads and writes via four new commands, added in a follow-up commit before Step 2 needs them:

```rust
async fn load_project_state(project_path: String) -> Result<Option<ProjectUiState>, Error>
async fn save_project_state(project_path: String, state: ProjectUiState) -> Result<(), Error>
async fn load_app_state() -> Result<AppUiState, Error>
async fn save_app_state(state: AppUiState) -> Result<(), Error>
```

Project path hashing: SHA-256 of the canonical absolute path, truncated to 16 hex chars. Stable across sessions. Raw path + name stored inside the JSON for debugging.

**Save strategy — three classes:**
- **Immediate** (fire-and-forget): tab opened/closed/reordered, layout mode changed, sidebar toggled
- **Debounced 1s**: scroll position, sidebar width (during drag), split divider position
- **Blur / quit**: cursor position (save on active-tab change and on app close — cursor precision isn't worth per-keystroke writes)

**Schema versioning.** Both JSON files carry a `schemaVersion: 1` field. When we change shape, bump and write a migration. Cheap insurance.

**Orphaned state cleanup.** Deferred. v0.1 accepts accumulation (files are tiny). Garbage collection on startup is a ~15-line follow-up if it becomes noticeable.

---
