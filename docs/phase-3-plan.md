# Phase 3 Plan — Project Intelligence

The actionable umbrella plan for Phase 3. Where [`roadmap.md`](roadmap.md) shows the full sequence and [`critical-path.md`](critical-path.md) explains *why*, this document is the *what to do next* for Phase 3 as a whole. Each sub-phase gets its own detail plan:

- [`phase-3.1-plan.md`](phase-3.1-plan.md) — link graph commands + rename-with-references (draft exists with resolved design decisions; full plan written when Step 1 starts)
- `phase-3.3-plan.md` — structural diff spike + implementation (written when Step 2 starts)
- `phase-3.2-plan.md` — structural lint engine (written when Step 3 starts)

This umbrella covers the sequencing, the prep work that blocks all three, and the Phase 2 carry-over that needs triage before we pick up Phase 3 pace.

## Context — what Phase 2 left us

Phase 2 is closed out. Shipped:

- 2.1 — Split view layout, real sidebar, tab bar, auto-save, watcher reload, per-project UI state persistence
- 2.2 — Inline preview decorations (images, emphasis, headings, links, code), with GFM and the stable-emphasis cursor-line workaround
- 2.3 — Frontmatter system: round-trip preservation, type-preserving panel, schema inference with autocomplete
- 2.4 — Markdown-aware spellcheck (Path A — OS/webview engine) + personal dictionary panel

That closes the v0.5 "daily driver" milestone from the roadmap, *except for the gate condition:* "no critical bugs in the demo loop after a month of dogfooding." Dogfooding hasn't meaningfully started. Step 0 addresses that.

## Sequencing — 3.1 → 3.3 → 3.2, not 3.1 → 3.2 → 3.3

Reading the phase numbers left-to-right implies 3.1 → 3.2 → 3.3. The roadmap's ordered list (items 3, 4, 6) does not — and the `phase-3.1-plan.md` draft agrees: "3.3 is the next high-stakes spike after 3.1." Rationale for the reshuffle:

1. **3.1 is the low-risk win.** The link graph is already built in Phase 1.4. The work is exposing it + the rename find-and-replace logic. Ship it early, bank the demo moment.
2. **3.3 is the second tech bet.** Same shape as the 2.2 spike — a throwaway proves the algorithm, *then* we commit. Book the risk early. If the structural diff turns out unreadable, we have time to adapt.
3. **3.2 is execution that depends on `.skrive.toml`.** The lint rules' entire configuration surface lives there. Moving 3.2 last gives us time to settle the schema (Step 0), absorb what 3.1 taught us about cross-file operations, and consume the dead-link data that 3.1 emits.

Phase 3 is the point where phase-number order stops matching build order for the first time, and the reader of the roadmap shouldn't have to re-derive why. Hence writing it down.

---

## Step 0 — Phase 3 prep

Four blocking items before any Phase 3 feature code is written. Step 0a is real code (the only feature-level work in this step); 0b, 0c, and 0d are documents, decisions, and triage. 0b and 0d can run in parallel with 0a; 0c (dogfooding) depends on 0a shipping.

### 0a. Pre-dogfood hardening

**Why first.** Before Skrive can be dogfooded on real content we need delete, folder-create, a right-click context menu, a command palette, in-project search, and "Open with Skrive" file associations. All are Phase-2-era paint that got deferred while we chased the critical path. None are new features; all are day-one editor affordances whose absence blocks 0c.

**Detail plan.** [`pre-dogfood-plan.md`](pre-dogfood-plan.md) — six steps, each with decisions, deliverables, and success criteria. Open-with-Skrive also resolves [open question P2](open-questions.md#p2-what-does-skrive-look-like-with-no-project-open).

**Estimated complexity.** Medium overall. Roughly one to two weeks, sequential where items share a component (context menu → delete/folder-create), parallelizable elsewhere.

### 0b. `.skrive.toml` schema decision

**Why first.** The schema is [open question A4](open-questions.md#a4-whats-the-schema-for-skrivetoml). It blocks Phase 3.2. Phase 2.4 already deferred the project dictionary to "the broader `.skrive.toml` story," so the schema shape affects that deferred work too. Phase 5.2c/e will read it as well. Design once.

**Deliverables.**
- `docs/skrive-toml-reference.md` — full schema reference: `[project]`, `[lint]`, `[lint.required_frontmatter]`, `[dictionary]`, `[export.*]`. Every section optional; a missing `.skrive.toml` is valid.
- Resolve A4 in `open-questions.md` with a short summary + a link to the reference doc.
- No parser yet. That lands in 3.2 Step 1, consumed by the lint engine.

**Decisions to make while writing the schema.**
- **Parse-time errors vs warn-and-continue.** If a user writes `broken_internal_links = "erorr"`, does Skrive refuse to open the project, show a toast, or silently default? Lean: toast + fall back to defaults. Never block project open.
- **Where do `[lint.required_frontmatter]` warnings surface?** Gutter marker, frontmatter panel indicator, or both?
- **Does `[dictionary].project_words` layer on top of the personal dictionary, or replace it for project files?** Lean: additive, so personal words always work and project words are extra.

**Estimated complexity.** Half a day for the schema doc + decisions. Another half day to resolve A4 and cross-reference from the two phase plans that need it.

### 0c. Phase 2 carry-over triage + dogfooding week

**Why now.** We said "start dogfooding with the phase plans themselves" in `phase-2.4-plan.md`. If we skip that and start 3.1 cold, Phase 3 features land on top of undiscovered Phase 2 bugs. Cheaper to flush the papercut queue first. Depends on 0a shipping.

**Deliverables.**
- A week of real use — this repo's docs + personal notes — with a running bug log (a simple `docs/dogfooding-notes.md`, discarded later).
- Explicit decisions on the parked items from Phase 2:
  - **Phase 2.2.5 math (KaTeX).** Slot before 3.1, after 3.1, or keep parked through v0.5? Lean: keep parked — math is cosmetic for the critical-path demo, and KaTeX is its own rabbit hole.
  - **Fenced-code language picker.** Mini-phase; probably keep parked.
  - **Cursor / scroll position persistence (deferred from 2.1).** Dogfooding will tell us if its absence bites daily use. If yes, fix before 3.1.
  - **Sidebar drag-resize (deferred from 2.1).** Same logic.
  - **Recent-projects history (deferred from 2.1).** Same.
- Any critical bugs surfaced by dogfooding get fixed in this step. Everything else gets filed and deferred.

**Estimated complexity.** A week calendar-time, most of which is non-coding use. A day to a few days of bug-fixing depending on what surfaces.

### 0d. Phase 3.3 algorithm decision

**Why now.** [Open question T1](open-questions.md#t1-what-algorithm-does-structural-diff-use). "Deserves a focused discussion before implementation." Doing it now — before 3.1 even starts — means by the time 3.1 ships, 3.3 is unblocked and we can go straight into the spike.

**Deliverables.**
- A decision memo (a section in `phase-3.3-plan.md` when we create it, or a standalone `docs/3.3-algorithm-memo.md`) evaluating block-hash + Hungarian vs Zhang-Shasha vs block-Myers on three real documents: something long (like `skrive-build-outline.md`), something short, something heavily reorganized between commits.
- Decision recorded and T1 moved to Resolved in `open-questions.md`.
- No implementation yet.

**Open sub-question to answer in the memo.** Does Phase 3.3 require the project to be a git repo? The build outline implies yes (`git2` is the history source). What happens for non-git projects — history panel not available, or a filesystem-snapshot fallback? Lean: not available, with a one-line message. Filesystem snapshots are scope creep.

**Estimated complexity.** Two days. Most of the work is running candidate algorithms against the real documents and eyeballing output quality.

---

## Step 1 — Phase 3.1 (link graph commands + rename-with-references)

Full plan: [`phase-3.1-plan.md`](phase-3.1-plan.md). Resolved design decisions already exist in the draft. 3.1 unblocks the moment Step 0b's schema is written down — 0c's dogfooding can run in parallel, and 0d's algorithm memo is 3.3's concern, not 3.1's.

**Open questions from the 3.1 draft to answer when the plan is fleshed out.**
- Line number + context snippet in the rename preview, or path only? Lean: path + line + short snippet.
- Rename keyboard shortcut: `F2`, `⌘R`, or something else? Lean: `F2` primary (Windows/Linux convention, avoids `⌘R` browser-reload collision in the webview), plus a Rename command in the command palette for macOS discovery.
- `⌘⇧B` for backlinks — verify it's not already taken by the webview or any CodeMirror default.
- Rename surface: active file (command palette + shortcut), sidebar-clicked file (context menu), or both? Lean: both, wired to the same confirmation modal.

**Pre-coding mini-spike (optional).** Reference-style link parsing (`[label]: target.md` definitions separated from `[text][label]` uses) is flagged non-trivial in the 3.1 draft. Half a day to prove the parser can track split definitions across an entire document before we lock in the full plan. If it's harder than expected, we reshape (e.g., defer reference-style to v0.5).

**Integration work the 3.1 draft doesn't yet call out.**
- Tab-store path updates when the renamed file is open in one or more tabs. Dirty state must be preserved across the path swap.
- Preview pipeline re-resolution — any tab whose preview is rendered needs its links recomputed after a rename that affected its references.
- Watcher suppression — a rename triggers many writes; the existing "our own write" suppression (a recently-saved timestamp per path) has to generalize to batches.

Record a short internal demo video the day the rename flow first works end-to-end. This is one of the three critical-path demo hooks.

---

## Step 2 — Phase 3.3 (structural diff)

Full plan: `phase-3.3-plan.md`, written when Step 1 ships. Structure mirrors 2.2:

- **Spike.** Throwaway implementation of the algorithm chosen in Step 0d. Run against the three documents from the decision memo. Answer: does the output read as "moved section / reworded paragraph / added heading," or as noise?
- **Go/no-go decision.** If yes, proceed to implementation. If no, fallback options live in [`critical-path.md`](critical-path.md#4-phase-33--structural-diff).
- **Implementation.** File history panel, diff view, semantic operation renderer, `git2` integration.

This is the demo hook. Record a short video the moment the spike produces its first readable diff — even if the implementation isn't done, the spike output is the HN-worthy frame.

**Scope questions to answer in the full plan.**
- Non-git projects — decided in Step 0d.
- Within-file line-level diff for "reworded paragraph" — reuse an existing diff crate or write our own? Lean: reuse `similar` or equivalent.
- History panel per-file or project-wide? Per-file is closer to the demo story; project-wide is closer to git log.

---

## Step 3 — Phase 3.2 (structural lint engine)

Full plan: `phase-3.2-plan.md`, written when Step 2 ships. This is execution, not a bet. The engine consumes:

- The link graph from 3.1 (for broken-link and orphan-file rules)
- The dead-link data 3.1 already emits (see decision 4 in `phase-3.1-plan.md`)
- The `.skrive.toml` schema from Step 0b
- The existing decoration infrastructure — a third layer alongside inline preview and spellcheck skips. Worth sketching the composition explicitly so the three layers don't step on each other.

**Lint UI surface.** Gutter markers in CodeMirror + a collapsible project-level panel, per the build outline. Ambient, not modal. Worth a design pass on how gutter markers coexist with spellcheck squiggles (visual weight, click interaction, priority when both apply to the same line).

---

## After Phase 3

v0.5 ships. The demo loop from [`critical-path.md`](critical-path.md#how-the-four-chain-into-the-demo) records cleanly end-to-end. At that point:

- Dogfood for a month — the v0.5 → v1.0 gate condition from the roadmap.
- Re-evaluate the roadmap; Phase 4 is importers, a well-understood slog.
- Start the Phase 5.2a PDF engine spike ([T2](open-questions.md#t2-what-engine-handles-pdf-export)) in parallel with Phase 4, since it's the next tech bet after structural diff.

---

## What's deliberately not in Phase 3

- **Importers, exporters, PDF engine.** Phases 4 and 5.
- **License validation, signing, distribution.** Phase 7.
- **Performance pass, aesthetic pass, keyboard audit.** Phase 6.
- **Collaboration, comments, sharing.** Not in the build outline; do not add.

If any of these creep in during Phase 3 work, push back and file it against the right phase.
