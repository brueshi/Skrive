# Skrive

> A Markdown editor for writers. Local-first, offline, portable plain text.

Skrive is a **Markdown editor** — not an Obsidian clone, not a knowledge base, not a second brain, not an AI writing tool. It opens a folder of `.md` files, edits them cleanly, and adds a small set of project-aware features (search, backlinks, safe renames) that keep Markdown portable instead of locking you into a proprietary store.

Built on Tauri 2, Svelte 5, and a Rust core.

## Status

**Alpha — v0.1.0.** Usable for real writing today; some rough edges remain. The four critical-path features (split view, inline preview, link graph + rename, structural diff) all shipped behind earlier versions; v0.1.0 closes out settings, typography, and the command runner. See the [v0.1.0 release notes](https://github.com/brueshi/Skrive/releases/tag/v0.1.0) for the alpha-launch summary.

## Download

Grab the latest macOS or Windows build from [Releases](https://github.com/brueshi/Skrive/releases). See [`docs/skrive-install.md`](docs/skrive-install.md) for platform-specific install notes. macOS is signed + notarized and opens cleanly; Windows is unsigned and will show a dismissable SmartScreen warning on first run.

## Features

### Editor
- CodeMirror 6 editor with a tailored Skrive theme
- Live decoration for headings, emphasis, code, images, and links
- Three layout modes — raw, split, preview — toggleable with `⌘1` / `⌘2` / `⌘3`, remembered per file
- Inline spell check with a per-project personal dictionary
- File switcher (`⌘P`) and a separate command palette (`⌘⇧P`) for actions
- OS file associations: open `.md` files straight from Finder or Explorer

### Project intelligence
- Project-scoped full-text search
- Wiki-link and Markdown-link backlinks, with a dedicated panel
- Outgoing-link and dead-link detection
- Rename a file and every reference to it updates across the project
- Version history (Git or local checkpoint) with a structural diff that reads paragraph-by-paragraph instead of line-by-line

### Files & frontmatter
- Folder-based — open any directory of Markdown; no vault setup, no import
- File tree sidebar: create, rename, delete, nest folders
- YAML frontmatter editing via a dedicated panel
- Filesystem watcher keeps the tree in sync with edits made outside the app

### Settings (`⌘,`)
- Editor typography: five curated presets (Editorial / Classic / Screen / Sans / Mono) plus a Custom field that uses any system-installed font
- Stepped size and line-height controls
- Personal dictionary management
- Auto-update toggle and on-demand "Check for updates"

### Configuration
- Per-project [`.skrive.toml`](docs/skrive-toml-reference.md) for dictionary, lint, and (forthcoming) export targets
- Auto-update on macOS

## Why it's nice to use

A couple of small things that make day-to-day writing feel good:

- **Actually the default Markdown app.** Register Skrive as the default handler for `.md` on macOS and double-clicking a file in Finder just opens it — no more accidentally launching Xcode because it grabbed the association last.
- **Claude Desktop artifacts open straight into the editor.** When an AI tool drops a `.md` file on your disk, there's no vault to import into and no web app to paste into — double-click and keep writing.

## Principles

- **Files are the source of truth.** Plain Markdown with YAML frontmatter on disk — always. Your work stays grep-able, git-friendly, and portable.
- **No database, no vault, no sync service.** The filesystem is the data layer.
- **The Rust core owns project intelligence.** The frontend renders and interacts.
- **No network calls, no accounts, no telemetry.** The only exception is user-initiated export to a third-party service.
- **No AI.** Not now, not quietly later.
- **One default theme done exceptionally** before a theme system exists.

## Development

Prerequisites: Rust toolchain, [Bun](https://bun.com), and the platform requirements listed in the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).

```bash
bun install
bun run tauri dev
```

## Project layout

```
.
├── docs/        # Install notes, design notes, .skrive.toml reference
├── src/         # Svelte 5 frontend
├── src-tauri/   # Rust core — Tauri commands, filesystem, project intelligence
└── static/      # Static assets served by SvelteKit
```

## License

Source-available under [PolyForm Noncommercial 1.0.0](LICENSE). Read it, run it for personal use. Commercial use is reserved.
