# Phase 2.4 Plan — Markdown-Aware Spellcheck

The next-session plan for Phase 2.4. Phase 2.3 (frontmatter system) shipped; with this phase done, Skrive becomes feature-complete enough to start serious dogfooding.

Phase 2.4's *only* differentiator over every other Markdown editor is **markdown-aware skipping** — spellcheck that ignores code blocks, inline code, URLs, link targets, frontmatter values, and heading anchors. That's the whole reason this phase exists. The engine itself is the OS's, because building one is a year-long distraction from a year of solved problems.

## Pre-flight checklist — what already exists

- [x] CodeMirror 6 editor surface uses contenteditable internally, so the webview's spellcheck applies natively. We only need to enable it.
- [x] Inline preview decoration infrastructure (`src/lib/editor/decorations/`) walks the syntax tree across visible ranges and dispatches to per-node handlers. The "skip these regions" logic mirrors that pattern exactly.
- [x] App-data persistence path (`AppUiState` in `src-tauri/src/persistence.rs`) is already wired for cross-session settings; the personal dictionary lives there too.

## Key decisions

1. **Path A — use the OS / webview's built-in spellchecker.** Per the planning conversation: WKWebView (macOS), WebView2 (Windows), and WebKitGTK (Linux) all ship a system-grade spellchecker on contenteditable surfaces. Enable it on the editor; skip the markdown structure we don't want checked via `Decoration.mark({ attributes: { spellcheck: "false" } })`. We get the user's preferred OS dictionary, right-click suggestions, "Learn Spelling", and multi-language support entirely for free. Bundle size unchanged.
2. **Markdown-aware skipping is the differentiator.** Every region the spellchecker shouldn't see — fenced code blocks, inline code, URLs, link targets, heading marks, frontmatter — gets a `spellcheck="false"` mark via the existing decoration tree-walker. New per-feature handlers in `src/lib/editor/decorations/spellcheck.ts`.
3. **Skrive-managed personal dictionary, additive to the OS.** Words on the user's Skrive personal list get `spellcheck="false"` decorations on every occurrence in any open file, regardless of what the OS thinks. The OS's "Learn Spelling" still works for adding to the OS dictionary; the Skrive dictionary is a separate, portable layer that the user controls explicitly. Stored in `AppUiState` so it persists across sessions and across project switches.
4. **Floating panel for managing the dictionary.** Same orthogonal-tool pattern as the frontmatter panel: a header indicator (e.g. `Aa · 12` for "12 words in personal dict"), invoked via `⌘⇧D`, dismissed via Escape or click-outside. Add words from a text input, remove with ×, see all words at a glance.
5. **No grammar, no style, no Hemingway-mode.** Out of scope. This is spellcheck.

## What's deliberately out of scope

- Grammar checking (different engine class entirely)
- Style suggestions
- Multi-language switching UI inside Skrive (the OS handles this)
- Project dictionary in `.skrive.toml` (deferred — adds `.skrive.toml` parsing complexity that we don't have yet; belongs with the broader `.skrive.toml` story)
- Custom squiggle visual treatment (requires running our own engine, defeats Path A)
- Right-click context menu interception (the OS owns it; intercepting would defeat Path A's main benefit)

---

## Step 1 — Enable webview spellcheck on the editor

**Goal.** The editor surface gets the OS's spellcheck applied to it. Misspelled words show the standard squiggle. Right-click on a squiggle opens the OS suggestions menu.

**Why first.** Smallest possible change with the highest visible impact. Verifies the platform-level assumption (that Tauri webviews honor `spellcheck="true"`) before we spend any time on the markdown-aware skipping.

**Deliverables.**
- `Editor.svelte` adds `EditorView.contentAttributes.of({ spellcheck: "true" })` to its extension list.
- Manual verification on the platforms we have access to (macOS at minimum). Note any platform-specific behavior in this doc.

**Files touched.**
- `src/lib/editor/Editor.svelte` — one extension added.

**Success criteria.**
- Open a file with deliberate misspellings, see the OS squiggle render in the editor.
- Right-click a squiggled word, see the OS suggestions menu.
- Pick "Learn Spelling", confirm the squiggle disappears (and stays gone after restart — that's the OS dict working).

**Estimated complexity.** Trivial. An hour, plus testing.

---

## Step 2 — Markdown-aware skip decorations

**Goal.** The five regions the spellchecker must not see get `spellcheck="false"` applied via decorations:

- Inline code (`` `foo` ``)
- Fenced code blocks (`` ```...``` ``)
- URLs in links and images (`[text](URL)` and `![alt](URL)`)
- Heading marks (`#`, `##`, ...)
- Frontmatter — both the `---` fences themselves and the YAML content between them

**Why second.** This is the actual differentiator. Without it, Path A would be no better than any other Markdown editor with default spellcheck on.

**Deliverables.**
- `src/lib/editor/decorations/spellcheck.ts` — new handler module that mirrors the pattern of the existing inline-preview handlers. For each Lezer node type listed below, push a `Decoration.mark({ attributes: { spellcheck: "false" } })` over the appropriate range.
- Node coverage:
  - `InlineCode` — entire node range
  - `FencedCode` — entire node range
  - `IndentedCode` — entire node range
  - `URL` (inside `Link` and `Image`) — entire node range
  - `LinkLabel` — leave alone (this *is* prose to spellcheck, like alt text)
  - `HeaderMark` — entire node range (the `#` characters, not the heading text)
  - For frontmatter: a separate handler that recognizes a leading `---...---` region and decorates the whole block. The Lezer markdown grammar may not give us a top-level frontmatter node, so this might need a small custom scanner over the document prefix. Mirrors the `stripLeadingFrontmatter` logic in `src/lib/preview/markdown.ts`.
- `inlinePreview()` (or a new `markdownSpellcheck()` factory) wires the handlers in alongside the existing inline-preview decoration plugin. They share the tree walker, so this is essentially free per update.

**Files touched.**
- `src/lib/editor/decorations/spellcheck.ts` — new.
- `src/lib/editor/decorations/index.ts` — wire the new handlers.
- Possibly `src/lib/editor/decorations/shared.ts` if the frontmatter region needs a different walking strategy than the per-node tree walk (probably yes — frontmatter is structural, not a Lezer node).

**Success criteria.**
- A file with `# Helo Wrld` shows squiggles only on `Helo` and `Wrld`, never on the `#`.
- A file with `` This is `inlne_kode` and a [link](htts://exampl.cm) `` shows squiggles only on `This` (if misspelled) and any other prose words. The contents of the inline code span and the URL are clean.
- A file with a fenced code block containing `def hellow_wold():` shows no squiggles inside the block.
- A file with frontmatter containing `title: Helo Wrld` shows no squiggles inside the YAML block.
- Heading text itself (the words after `#`) gets spellchecked normally.

**Estimated complexity.** Small. Half a day to a day, mostly figuring out the Lezer node names and verifying behavior on real files.

---

## Step 3 — Personal dictionary storage + decoration layer

**Goal.** Words on the Skrive personal dictionary get `spellcheck="false"` on every occurrence in any open file, layered on top of the markdown-aware skipping. Persisted in `AppUiState`.

**Why third.** Storage is small and the decoration application is straightforward, but it depends on Step 2's decoration architecture being in place.

**Deliverables.**

*Rust side.*
- `AppUiState` gains `personal_dictionary: Vec<String>` with `#[serde(default)]` so existing app-state files load without migration.
- No new Tauri commands needed — the existing `load_app_state` / `save_app_state` cover the wire path.

*Frontend side.*
- `src/lib/stores/preferences.svelte.ts` (new — small store wrapping `AppUiState` reads/writes for app-wide settings; we don't have one yet because Phase 2.1 deferred it). Exposes `personalDictionary: string[]`, `addPersonalWord(word)`, `removePersonalWord(word)`. Each mutation triggers a debounced `save_app_state`.
- A new decoration handler in `src/lib/editor/decorations/spellcheck.ts` that runs after the markdown-aware skipping. For each word in the personal dictionary, find every occurrence in the document's prose regions (not the already-skipped code/URLs/etc.) and add `spellcheck="false"` to those ranges.
- Word matching: case-insensitive, whole-word boundaries (no substring matches). The personal dictionary stores the user's preferred casing for display; matching ignores case.

**Files touched.**
- `src-tauri/src/persistence.rs` — extend `AppUiState`.
- `src/lib/stores/preferences.svelte.ts` — new.
- `src/lib/editor/decorations/spellcheck.ts` — extend with the personal-dict handler.
- `src/lib/types.ts` — extend `AppUiState` mirror.

**Success criteria.**
- Add `Skrive` to the personal dictionary. Type `Skrive is great.` in any file. No squiggle on `Skrive`.
- Remove `Skrive` from the dictionary. The squiggle returns within one keystroke.
- Add a project-specific name (e.g. `Bruechnerverse`). Confirm it persists across app restart.
- A word that appears inside an inline code span is *already* skipped by Step 2, so the personal-dict layer is redundant there — that's fine, no double-counting issue.

**Estimated complexity.** Small. A day, including the new preferences store.

---

## Step 4 — Personal dictionary panel

**Goal.** A floating panel for viewing and editing the personal dictionary. Same orthogonal-tool pattern as the frontmatter panel.

**Deliverables.**

*Header indicator.*
- `Header.svelte` gains a second indicator next to the `FM · N` one: `Aa · N` where N is the personal dictionary size. The visual treatment matches the FM indicator (monospace, muted-until-hover, active-state styling).
- Click toggles the panel. `⌘⇧D` is the keyboard shortcut.

*Floating panel.*
- `src/lib/components/PersonalDictionaryPanel.svelte` — new. Floating panel anchored to the top-right, similar layout to the frontmatter panel but simpler:
  - Header: "Personal dictionary" + count
  - Body: a list of words, alphabetized. Each word has a × to remove.
  - Footer: a text input with "Add word…" placeholder. Enter or comma commits a new word. Trim whitespace, dedupe, ignore empty input.
- Same 180ms grid-row + opacity-fade animation as the frontmatter panel. Same Escape / click-outside dismiss.

*Add-from-cursor shortcut.*
- A keyboard shortcut (`⌘'` proposed) that adds the word at the cursor to the personal dictionary. Detects the word boundary, looks up the text, calls `addPersonalWord(text)`. If the cursor isn't on a word, no-op silently.
- This is the answer to "the OS's Learn Spelling can't add to the Skrive dict" — `⌘'` is Skrive's equivalent gesture.

**Files touched.**
- `src/lib/components/PersonalDictionaryPanel.svelte` — new.
- `src/lib/components/Header.svelte` — second indicator.
- `src/routes/+page.svelte` — mount the panel, wire `⌘⇧D` and `⌘'` shortcuts.
- `src/lib/stores/preferences.svelte.ts` — adds `dictionaryPanelOpen: boolean` session state and toggle methods (mirrors `frontmatterPanelOpen`).

**Success criteria.**
- Press `⌘⇧D`, see the panel slide in. Indicator shows `Aa · 0` initially, increments as words are added.
- Type a word in the footer input, press Enter, see it appear in the list (alphabetized).
- Click × on a word, see it removed.
- Position cursor on a misspelled word in the editor, press `⌘'`, see the word added to the dict; squiggle disappears immediately.
- Close and reopen the app — words persist.

**Estimated complexity.** Small to medium. A day, mostly because of the new indicator + shortcut wiring.

---

## After Phase 2.4

Phase 2.4 closes out the v0.5 "daily driver" milestone (per `docs/roadmap.md`). At that point we have: project scanning + opening, multi-tab editing with autosave, three-mode layout, inline preview decorations, frontmatter system, and spellcheck. Skrive is usable as a real Markdown editor for serious work.

Next phase plan to write: Phase 3.1 (link graph commands + rename-with-references). The design decisions are already captured in [`phase-3.1-plan.md`](phase-3.1-plan.md). After that, the second technical-bet spike for Phase 3.3 (structural diff).

We should also:

- Record short demo videos of each Phase 2.4 step shipping (per the "demo each piece" decision from the post-2.3 conversation).
- Start using Skrive on real documents — these phase plans themselves are the obvious first dogfooding target.
- Re-evaluate the `.skrive.toml` story now that two features (project dictionary, frontmatter schema) want to land in it.
