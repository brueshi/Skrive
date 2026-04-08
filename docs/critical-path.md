# Critical Path

The four sub-phases that determine whether Skrive is viable. Everything else in [`roadmap.md`](roadmap.md) is execution. These four are bets.

The order matters. 2.1 is a prerequisite for 2.2 (you can't build inline previews without a layout to put them in). 2.2 and 3.3 are independent of each other but both gate v0.1, so they can run in parallel if we want. 3.1 has the lowest risk and the highest visible payoff, so it slots in early as a win.

| # | Sub-phase | Bet type | Failure mode |
|---|---|---|---|
| 1 | 2.1 — Split view layout | Execution | Slow, but won't kill the project |
| 2 | 2.2 — Inline preview decorations | **Tech bet** | Editor experience falls apart |
| 3 | 3.1 — Link graph commands + rename | Execution | Slow, but well-understood |
| 4 | 3.3 — Structural diff | **Tech bet + demo hook** | No HN story, no hook |

---

## 1. Phase 2.1 — Split view layout

### What it is

Three layout modes for the editor surface:

- **Raw only** — distraction-free writing, just the CodeMirror surface
- **Split** — editor on the left, rendered preview on the right, drag-resizable divider
- **Preview only** — for reading and review

Layout state is persisted **per file** (per the build outline). Mode toggle is a keyboard shortcut.

### Why it's on the critical path

Not because it's risky — it isn't — but because nothing else in Phase 2 makes sense without it. Inline previews (2.2) live inside whichever pane the user is editing in. Frontmatter UI (2.3) needs a place to dock above the editor. Without 2.1 we'd be putting features into a layout that doesn't exist.

### What success looks like

- Three modes work, drag-resize is smooth (no jank, no layout shift on pane swap)
- Mode persists per file across app restarts
- Sidebar (file list) coexists with the layout — opening a file from the sidebar doesn't reset the user's chosen mode
- Keyboard shortcuts for all three modes are documented

### What failure looks like

There isn't really a failure mode here. The risk is *time spent* (drag-resizable splitters with persistence are surprisingly fiddly to get right), not *technical possibility*.

### Hidden scope

Several things have to land alongside the layout itself:

- File dialog (`tauri-plugin-dialog`) — required to actually open a project
- File-list sidebar component
- "Currently open file" state model on the frontend
- Persistence layer for per-file UI state (see [`open-questions.md`](open-questions.md) — `.skrive/` vs platform app data)

These are tracked separately in [`phase-2-plan.md`](phase-2-plan.md).

---

## 2. Phase 2.2 — Inline preview decorations

### What it is

Markdown rendering inside the CodeMirror editor itself. Not a side panel, not a separate view — *inline*. Images render where they're written. Math equations render. Links display as styled text instead of `[text](url)` syntax. The raw syntax collapses when the cursor moves away from a span and reappears when the cursor enters it.

This is what Typora pioneered. It is a substantial differentiator over Obsidian's "click to switch modes" approach.

### Why it's the riskiest piece in the entire outline

Three reasons:

1. **Coupling to CM6's decoration system.** CM6 supports widget decorations (which can host arbitrary DOM) and replace decorations (which hide ranges of text). Combining them to get "raw syntax visible when cursor is here, rendered when cursor is elsewhere" requires careful state management. The patterns exist (Obsidian's editor uses CM6 decorations heavily), but they aren't documented end-to-end and we'll be discovering edge cases ourselves.
2. **Conflict with the "transactions only" rule.** Decorations are part of editor state and update via transactions, which is fine. But if we ever need to mutate decoration content imperatively (e.g., a math equation re-renders when LaTeX libraries finish loading async), we have to thread that through transactions too. This is solvable but adds friction.
3. **The fold-on-cursor-leave behavior is custom.** No off-the-shelf CM6 extension does this exactly. We'll be writing it ourselves.

### What success looks like

- Inline images render inside markdown lines (e.g., `![alt](path.png)` shows the actual image)
- `**bold**` displays as just **bold** when the cursor is on another line, and reverts to `**bold**` when the cursor enters that line
- Inline code spans `like this` render as styled text without the backticks
- Math equations render via KaTeX or similar
- Link syntax `[text](url)` displays as just the styled text with the URL hidden
- All of the above survive arbitrary edits without flickering, broken decorations, or stale renders
- Cursor placement is intuitive — clicking on a rendered image places the cursor at the start of the underlying syntax

### What failure looks like

- Decorations lose sync with the underlying document on rapid edits (most likely failure mode)
- Cursor placement is unintuitive — clicking on rendered content goes to the wrong place in the source
- Performance degrades on documents with many inline decorations
- Some markdown constructs (nested emphasis, links inside headings) can't be cleanly handled

### Failure response

If 2.2 doesn't work, we have three options, ordered by how much they cost:

1. **Limit the scope of inline previews.** Ship only inline images and inline code spans for v0.1. Defer fold-on-cursor for emphasis to v0.5 or v1.0. The product is still differentiated, just less so.
2. **Bend the "transactions only" rule.** Allow imperative DOM mutations for decoration widgets that need async updates (math, embeds). Document the exception clearly. The rule was meant to prevent state drift, not to be religious.
3. **Switch to a contenteditable WYSIWYG approach.** Throw out CodeMirror for the inline-preview surface and build on contenteditable like Typora does. This is a *major* rearchitecture and we'd lose CodeMirror's strengths (vim mode, search, multi-cursor, gutter markers). Last resort.

### The spike

Before committing to the full 2.2 implementation, we build a 1–2 day throwaway that proves three specific things work:

1. Can a CM6 widget decoration render an inline image inside a markdown line?
2. Can a fold decoration collapse `**bold**` to **bold** when the cursor leaves the line?
3. Can the fold restore when the cursor returns to that line?

If all three work, proceed. If any one fails, we have the failure-response conversation above.

The spike is the **gating decision** for Phase 2.2 and arguably for the entire product. Tracked in [`phase-2-plan.md`](phase-2-plan.md).

---

## 3. Phase 3.1 — Link graph commands + rename-with-references

### What it is

The Rust core already builds a forward and back link graph in Phase 1.4. Phase 3.1 exposes it through Tauri commands and adds the *killer feature*: rename a file, and every reference to it in every other file updates automatically.

Commands to add:

```rust
async fn get_backlinks(path: String) -> Result<Vec<LinkReference>, Error>
async fn get_dead_links(path: String) -> Result<Vec<DeadLink>, Error>
async fn rename_file(old: String, new: String) -> Result<Vec<UpdatedReference>, Error>
```

### Why it's on the critical path

It's the single feature that separates Skrive from every other Markdown tool. Obsidian has it for `[[wiki-links]]` only. Notion has it because everything is a database row. Bear doesn't have it. Standard Markdown editors definitely don't have it.

It's also low-risk — the link graph is built and tested. Phase 3.1 is mostly *exposing* what exists, plus the find-and-replace logic for references during rename.

### What success looks like

- `get_backlinks(path)` returns every file that links to `path`, with the byte range of each link in the source
- `rename_file(old, new)` atomically (or with a clear failure path) renames the file on disk AND rewrites every reference to it in every other file in the project, AND returns a list of what changed for the UI to display
- `get_dead_links(path)` returns every link in `path` that points to a file that doesn't exist
- All three commands respect the project root boundary — no rename can move a file outside the project

### What failure looks like

- Rename leaves the project in a partially-updated state (some references updated, others not)
- Reference rewriting handles `[text](old.md)` correctly but not `[[old]]` wiki-links, or vice versa
- Edge cases break things: a link with a fragment (`old.md#section`), a link with query params, a link inside a code block, a link inside a comment

### Mitigation

Atomicity is the hard part. Two approaches:

1. **Two-phase commit** — compute all the changes, then apply them all, then rename the file. If any step fails, roll back. Complex but safe.
2. **Best-effort with detailed reporting** — apply each change as we go, return a report of what succeeded and what failed. Simpler but less safe.

For v0.1 I'd recommend (1) with the rollback path tested explicitly. For v0.5 we may want a Git-aware variant that uses Git as the rollback mechanism, but that's premature for now.

Edge cases we explicitly need to handle:
- Links with fragments (`./file.md#heading`) — fragment must be preserved
- Links inside code blocks and inline code — must NOT be rewritten
- Wiki-links with display text (`[[old|Display Text]]`) — only the target half changes
- Renames that change only the file's casing on case-insensitive filesystems (macOS, Windows) — needs special handling

---

## 4. Phase 3.3 — Structural diff

### What it is

A diff view that operates on document *structure* rather than raw lines. Instead of red/green line noise, the user sees semantic operations: "moved this section from here to there", "reworded this paragraph", "added a new heading".

Algorithm sketch (from build outline):
1. Parse both versions of the document into an AST
2. Diff the AST at the block level: paragraphs, headings, lists, code blocks
3. Render the diff as semantic operations

Implementation depends on:
- The `git2` Rust crate for reading the project's existing git history
- A block-level diff algorithm (not yet chosen — see [`open-questions.md`](open-questions.md))
- A renderer that maps diff operations to readable UI (not red/green gutters)

### Why it's the demo hook

This feature does not exist in any current Markdown tool. It is the single thing that, when shown in a screen recording, makes someone stop scrolling. The HN launch plan explicitly calls it out as one of the three things to show in the demo video.

If the inline preview (2.2) is the writing experience, the structural diff (3.3) is the *story*. People will share the diff demo even if they don't use Skrive themselves.

### What success looks like

- Open a file's history panel, see a list of past commits
- Click two commits, see a structural diff between them
- The diff says "Section 'Architecture' moved from after 'Introduction' to after 'Goals'" instead of showing 40 lines of red and green
- Reworded paragraphs show inline diffs *within* the paragraph, not as full delete + insert
- New headings, removed headings, and reorderings are clearly distinguished
- The diff is readable without any prior knowledge of how Skrive's diff algorithm works

### What failure looks like

- The diff is technically correct but unreadable — too granular, too noisy
- The "moved section" detection has too many false positives or false negatives
- Reworded paragraph diffs degenerate into full delete + insert
- The diff is slow on documents larger than ~10,000 words

### Algorithm decision

This is the biggest open technical question in the entire roadmap. Three candidate approaches:

1. **Block-hash matching with a Hungarian-algorithm fallback for moves.** Hash each block by its normalized content, match identical hashes between versions, run Hungarian on the unmatched blocks to find best fuzzy matches. Fast, simple, good enough for most documents. **My recommendation for v0.1.**
2. **Tree edit distance (Zhang-Shasha algorithm).** Mathematically optimal — finds the minimum number of insert / delete / relabel operations to transform one tree into another. Slow on large documents (cubic in tree size), but correct. **Worth considering for v1.0** if v0.1's block-hash approach has too many edge cases.
3. **Myers diff applied to a flattened block list.** Same algorithm Git uses, but operating on whole blocks instead of lines. Familiar, well-understood, but doesn't natively detect moves — moves show up as delete + insert in different positions.

I'd start with (1) and benchmark against real documents. If the move detection is good enough, ship it. If not, escalate to (2) for v1.0.

This deserves a focused discussion before implementation. Tracked in [`open-questions.md`](open-questions.md).

---

## How the four chain into the demo

The 90-second Show HN screen recording, in order:

1. **(0:00–0:10)** Open Skrive. Open a real project (file dialog from 2.1).
2. **(0:10–0:30)** Click into a file. Show inline preview working: type `**bold**`, watch it collapse. Type an image syntax, watch it render. (Phase 2.2 in action.)
3. **(0:30–0:50)** Right-click a file in the sidebar. Rename it. Switch to another file that linked to it. Watch the link update automatically. (Phase 3.1 — the killer feature.)
4. **(0:50–1:20)** Open the file history. Pick two commits. Show the structural diff: "Section moved", "Paragraph reworded". Compare to a normal Git diff side-by-side for contrast. (Phase 3.3 — the demo hook.)
5. **(1:20–1:30)** Cut to the Skrive landing page. Buy button. End.

Every second of this demo depends on these four sub-phases working. That's why they're the critical path.
