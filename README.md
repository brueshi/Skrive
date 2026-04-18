# Skrive

> A Markdown IDE for people who write seriously and ship to the web.

Tauri 2.0 + Svelte 5 + Rust core. Offline-first. Local. Private.

## Status

Pre-alpha — usable for real writing, but rough. Phase 2 (core editor) shipped; Phase 3 (project intelligence) in progress. See [`docs/skrive-build-outline.md`](docs/skrive-build-outline.md) for the full build plan.

## Download

Grab the latest macOS or Windows build from [Releases](https://github.com/brueshi/Skrive/releases). See [`docs/install.md`](docs/install.md) for platform-specific install notes. macOS is signed + notarized and opens cleanly; Windows is unsigned and will show a SmartScreen warning on first run (dismissable — see the install doc).

## Principles

- Files are the source of truth. Always plain Markdown with YAML frontmatter on disk.
- The Rust core owns all project intelligence. The frontend renders and interacts.
- No network calls, no accounts, no telemetry. (User-initiated exports to third-party services are the only exception.)
- One default theme done exceptionally before a theme system exists.

## Development

Prerequisites: Rust toolchain, Node 20+, and the platform requirements listed in the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

## Project layout

```
.
├── docs/                # Build outline and design notes
├── src/                 # Svelte 5 frontend
├── src-tauri/           # Rust core (Tauri 2 commands, file system, project intelligence)
└── static/              # Static assets served by SvelteKit
```
