# Skrive Roadmap

The full Phase 2–7 sequence after Phase 1 (foundation) is complete.

This is a derivative of [`skrive-build-outline.md`](skrive-build-outline.md), reordered for **build sequence** rather than spec order. The build outline answers *what* we are building. This document answers *in what order and why*.

## Sequencing principles

1. **De-risk the technical bets first.** The two pieces that could kill the project (inline preview decorations, structural diff) ship before any importer or exporter code is written. If they don't work, we want to know early — not at month four.
2. **Build the demo loop before building width.** The Show HN moment requires three things: inline preview, link graph rename, structural diff. Everything else can be unfinished and we still have a story. Reverse the order and we have a wide app with no hook.
3. **Save the well-understood grunt work for last.** Importers and exporters are tedious but predictable. They expand to fill the time available. They go after the bets are proven.
4. **Frontmatter, link graph, lint, and watcher are already half-built in Phase 1.** Phase 2.3 and Phase 3.1 are mostly *exposing* what the Rust core already does, not building it from scratch.

## The full ordered list

Items 1–4 are the **[critical path](critical-path.md)** — the must-prove technical bets and demo hooks. Items 5+ are execution.

| # | Phase | Title | Risk | Complexity | Depends on |
|---|---|---|---|---|---|
| 1 | 2.1 | Split view layout + file dialog plumbing | Low | M | Phase 1 |
| 2 | 2.2 | Inline preview decorations | **High** | L | 2.1, spike |
| 3 | 3.1 | Link graph commands + rename-with-references | Low | M | Phase 1.4 |
| 4 | 3.3 | Structural diff | **High** | L | git2, AST diff algo |
| 5 | 2.3 | Frontmatter system (UI + schema inference) | Low | M | Phase 1.4 |
| 6 | 3.2 | Structural lint engine | Low | M | 3.1, `.skrive.toml` |
| 7 | 2.4 | Markdown-aware spellcheck | Medium | M | — |
| 8 | 4.1 | Obsidian importer | Low | M | `Importer` trait |
| 9 | 4.4 | Raw directory importer | Low | S | 4.1 |
| 10 | 5.1a | Free exports: Markdown, GFM, single-file HTML, raw dir | Low | M | `Exporter` trait |
| 11 | 5.1b | Free exports: Obsidian vault, Bear x-callback | Low | M | 10 |
| 12 | 4.2 / 4.3 | Notion + Bear importers | Medium | M | 8, 11 |
| 13 | 5.2a | PDF export with full typography | **High** | L | engine spike |
| 14 | 5.2b | Notion API export | Medium | M | network exception |
| 15 | 5.2c | Astro / Docusaurus / Next.js MDX exports | Low | M | `.skrive.toml` |
| 16 | 5.2d | ePub export | Low | M | — |
| 17 | 5.2e | Custom render target via `.skrive.toml` | Low | M | 15 |
| 18 | 6.1 | Performance pass | Medium | M | full app |
| 19 | 6.2 | Aesthetic pass | Low | M | full app |
| 20 | 6.3 | Keyboard audit + documentation | Low | S | full app |
| 21 | 7 | License validation, signing, distribution | Low | M | 18 |

**Complexity legend:** S = days, M = a week or two, L = 2–4 weeks, XL = month+. These are relative, not calendar predictions.

## Milestones

The 21 items group into three releases.

### v0.1 — "the bet" (items 1–4)

**What it is:** The four critical-path items, plus enough plumbing to demo them on a real project. Not yet a product anyone would use day-to-day.

**Demo loop:**
1. Open a real project (file dialog)
2. Edit a file with inline preview working (Phase 2.2)
3. Rename a file and watch references update (Phase 3.1)
4. Open the file history and see a structural diff (Phase 3.3)

If this loop works end-to-end, the product sells itself in a 90-second screen recording. If it doesn't, we have a hard conversation about what to cut or change.

**Gate to v0.5:** v0.1 must be recordable without bugs. If we can't demo it, we don't move on.

### v0.5 — "the daily driver" (items 5–11)

**What it is:** Skrive becomes good enough that you can use it as your daily Markdown editor for serious work. Frontmatter system, lint, spellcheck, importers from the most common tools, basic exports.

**Who it's for internally:** Us. We use it on real projects (this repo's docs, future blog content, etc.) and find what breaks.

**Gate to v1.0:** No critical bugs in the demo loop after a month of dogfooding. Importers handle real Obsidian vaults and Bear archives without losing data.

### v1.0 — "ship it" (items 12–21)

**What it is:** The full product as specified in Phase 1–7 of the build outline. PDF export with real typography. Static-site exports for Astro / Docusaurus / Next.js MDX. Signed and notarized installers. Local license validation. Paddle integration. The HN launch happens here.

**Who it's for:** Technical writers, developer advocates, documentation engineers — the private beta audience from the launch plan.

## What this roadmap does not commit to

- **Calendar dates.** Items have relative complexity, not weeks or months. Estimating duration on a project this size with a two-person team (you + me) is dishonest.
- **Parallelism.** Some items can be developed in parallel (e.g., spellcheck while exports are being built). The list above is *dependency order*, not strict serialization.
- **Backwards compatibility between phases.** The Rust core's data model is allowed to change between v0.1 and v0.5. Once we ship v1.0, file format compatibility becomes a hard constraint.

## Living document

This roadmap is updated as the project evolves. Every time a phase completes, ships, or changes scope, this document is the place that tracks it. Compare to [`open-questions.md`](open-questions.md) for the things we *haven't* decided yet.
