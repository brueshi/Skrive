# Skrive

> A writing and notes app for people who want their words in plain files they own. Local-first, offline, portable.

Skrive is a **writing and notes app** — not an Obsidian clone, not a knowledge base, not a second brain, not an AI writing tool. It opens a folder of plain files, lets you write in them cleanly with a rich rendered surface when you want it, and adds a small set of project-aware features (search, backlinks, safe renames). Markdown is the storage format, not the point — your words stay in portable plain text you own, never a proprietary store.

What makes 1.0 different from every other Markdown app: it is a **document you write in, not a code editor with a preview**. One canonical Markdown file, two surfaces projected over it — a no-syntax rich surface for everyone, and an honest source surface for the Markdown-literate. The bytes on disk are always plain Markdown you could have typed by hand.

Built on Electron and React, with a small native Rust core (via napi-rs) for structural diffing.

## Status

**1.0.0 — "Overcast."** A two-part milestone: the editor was rebuilt around a text-canonical projection model, and the entire interface was redesigned. See the [1.0.0 release notes](https://github.com/brueshi/Skrive/releases/tag/v1.0.0) for the full story.

## Download

Grab the latest macOS or Windows build from [Releases](https://github.com/brueshi/Skrive/releases). macOS (Apple Silicon) is signed + notarized and opens cleanly; Windows is unsigned and shows a dismissable SmartScreen warning on first run (*More info -> Run anyway*). See [`docs/skrive-install.md`](docs/skrive-install.md) for platform notes.

## The editor

One Markdown file, two ways to work in it:

- **Rich** — a no-syntax writing surface for everyone. Bold, headings, lists, quotes, dividers, tables, and links appear as the real thing, never as raw `**` or `#`. Structure is created through a toolbar, a selection bubble, and a slash menu, so you build a document without typing a fence.
- **Text** — an honest source surface for people who know Markdown, with a choice of how present the syntax is: **Raw**, **Recessed**, or **Concealed**.

Both surfaces edit the *same* file; switch with `⌘⇧E` and your content carries over untouched. New documents open in Rich by default. Underneath, a source-mapped parser/serializer keeps the round-trip **byte-faithful** — touched blocks re-serialize to canonical Markdown, untouched bytes stay identical — so the file is never a lossy export.

## Project intelligence

- Project-scoped full-text search with a live context preview of each match
- Bidirectional backlinks (what links *to* a document and what it links *out* to), with folder tags
- Outgoing-link and dead-link detection
- Rename a file and every reference to it updates across the project
- Version history (Git or local checkpoint) with a structural diff that reads paragraph-by-paragraph instead of line-by-line
- Project linting runs in a background worker, so typing stays smooth at any project size

## Files & frontmatter

- Folder-based — open any directory of Markdown; no vault setup, no import
- File-tree sidebar: create, rename, delete, nest folders
- YAML frontmatter editing via a dedicated panel
- Durable saves: atomic writes (a crash can't corrupt a file), debounced autosave, external-change detection that asks before overwriting, and a flush before quit
- Filesystem watcher keeps the tree in sync with edits made outside the app
- OS file associations: open `.md` files straight from Finder or Explorer

## Interface

The 1.0 "Overcast" design — a warm near-white page on a dove-grey desk, a slate-indigo accent, and custom iconography:

- Full-page Settings (`⌘,`) with grouped cards
- Side panels (backlinks, frontmatter, history) dock as cards beside a narrowing editor
- A topbar with the window-controls cluster, lifted tabs, a Rich/Text surface toggle, and a quiet save indicator
- Editor preferences that take effect live: line measure, smart typography, format on save, autosave delay
- A command palette (`⌘⇧P`), file switcher (`⌘P`), and keyboard cheat sheet, all in the Overcast language

## Principles

- **Files are the source of truth.** Plain Markdown with YAML frontmatter on disk — always. Your work stays grep-able, git-friendly, and portable.
- **No database, no vault, no sync service.** The filesystem is the data layer.
- **Text is canonical; everything richer is a projection of it**, never a container that owns content. No proprietary format, no lossy export.
- **No network calls, no accounts, no telemetry.** The only exception is user-initiated export to a third-party service.
- **No AI.** Not now, not quietly later.
- **One default look done exceptionally** before a theme system exists.

## Development

Prerequisites: [Bun](https://bun.com) and a Rust toolchain (for the native diff core).

```bash
bun install
bun run start        # launch the app in dev (electron-vite)
bun run typecheck    # type-check shared / app / shell
bun run test         # vitest
```

Packaging (`bun run package:mac` / `:win`) is a CI-only path — it signs and notarizes on macOS using secrets the release workflow provides.

## Project layout

```
.
├── app/          # React renderer — editor surfaces, panels, UI
├── shell/        # Electron main + preload + IPC, project intelligence
├── shared/       # Shared types and IPC contracts
├── native/diff/  # Rust structural-diff core (napi-rs)
└── docs/         # Install notes, design notes, .skrive.toml reference
```

## License

Source-available under [PolyForm Noncommercial 1.0.0](LICENSE). Read it, run it for personal use. Commercial use is reserved.
