# Skrive — Full Build Outline

> A Markdown IDE for people who write seriously and ship to the web.
> Tauri 2.0 + CodeMirror 6 + Rust core. Offline-first. Local. Private.

---

## Principles

- Files are the source of truth. Always plain Markdown with YAML frontmatter on disk.
- The Rust core owns all project intelligence. The frontend renders and interacts.
- No network calls ever. No accounts. No telemetry.
- One default theme done exceptionally before a theme system exists.
- Ship less, finish it.

---

## Phase 1: Foundation

### 1.1 Project Scaffolding

- Initialize Tauri 2.0 with a Svelte frontend
- Configure Tauri security policy: file system access scoped to the user's chosen project directory only, no network access by default
- Establish monorepo structure: `src-tauri/` for Rust core, `src/` for Svelte frontend, `src/editor/` for CodeMirror layer

### 1.2 CodeMirror 6 Editor Core

Install and configure the following extensions from day one:

- `@codemirror/lang-markdown` for syntax support
- `@codemirror/view` for the editor view layer
- `@codemirror/state` for immutable transaction-based state
- A custom theme extension establishing the visual identity

Rules:
- The editor is a controlled component from the start
- Every state change goes through CodeMirror's transaction system
- No imperative mutations anywhere

### 1.3 Rust File System Core

Build a clean Tauri command interface. The backend owns all file operations:

```rust
#[tauri::command]
async fn open_project(path: String) -> Result<ProjectManifest, Error>

#[tauri::command]
async fn read_file(path: String) -> Result<FileContent, Error>

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), Error>

#[tauri::command]
async fn watch_project(path: String) -> Result<(), Error>
```

- File watching via the `notify` crate
- Every file change emits a Tauri event to the frontend
- The frontend never polls

### 1.4 Project Model

On project open the Rust core:

1. Scans the directory recursively
2. Parses frontmatter from every Markdown file
3. Builds an in-memory link graph
4. Emits the initial `ProjectManifest` to the frontend

The index lives in Rust. The frontend requests derived data via commands. The frontend never manages project state directly.

---

## Phase 2: Core Editor Experience

### 2.1 Split View Architecture

Three layout modes, established early because they affect everything:

- **Raw only** for distraction-free writing
- **Split** with editor left and preview right, drag-resizable
- **Preview only** for reading and review

Mode toggle is a keyboard shortcut. The layout state persists per file.

### 2.2 Inline Preview Renderer

Build a custom Markdown renderer, not a library drop-in. Full control over every element is required.

- Preview pane uses a `unified` or `marked` pipeline on the frontend
- Inline previews inside the CodeMirror editor are CodeMirror decorations
- Images, rendered math, and embeds appear inline while writing
- Raw syntax collapses when the cursor moves away from it

This is the first major differentiator. It must feel native to the writing flow, not like a separate panel that happens to be visible.

### 2.3 Frontmatter System

Frontmatter is a structured subsystem, not raw YAML in the editor.

Rust core responsibilities:
- Parse YAML frontmatter from every file on index
- Infer a project-level schema from common fields across files
- Track which fields are present, missing, or inconsistent

Editor surface:
- A dedicated frontmatter panel above the document body
- Field-level autocomplete based on the inferred schema
- Auto-updating fields on every save:
  - `last_modified` updates automatically
  - `reading_time` updates on content change
  - `word_count` always current

### 2.4 Spellcheck

Local spellcheck only. No network. Options: `nspell` on the frontend or a Rust-based engine via the backend.

Critical requirement: spellcheck must understand Markdown structure. It skips:
- Code blocks and inline code
- URLs and link targets
- Frontmatter values
- Heading anchors

It only checks prose. This is not the default behavior of most implementations and must be explicitly built.

---

## Phase 3: Project Intelligence

### 3.1 Link Graph

The Rust core maintains a directed graph of all internal links. Every file is a node. Every `[text](path)` and `[[wiki-link]]` is an edge. The graph updates incrementally on file save.

Commands:

```rust
#[tauri::command]
async fn get_backlinks(path: String) -> Result<Vec<LinkReference>, Error>

#[tauri::command]
async fn get_dead_links(path: String) -> Result<Vec<DeadLink>, Error>

#[tauri::command]
async fn rename_file(old: String, new: String) -> Result<Vec<UpdatedReference>, Error>
```

Rename a file and all references update automatically. This feature alone separates Skrive from every other Markdown tool.

### 3.2 Structural Linting

A lint engine that runs on document save. Rules are configurable at the project level via `.skrive.toml`.

Default ruleset:
- Broken internal links
- Missing required frontmatter fields
- Heading hierarchy violations (h3 before h2)
- Orphaned files with no inbound links
- Duplicate headings within a file

Lint results surface as gutter markers in CodeMirror and a collapsible project-level panel. Not modal dialogs. Not blocking. Ambient and ignorable.

### 3.3 Structural Diff

The second major differentiator. A diff view that operates on document structure rather than raw lines.

Algorithm:
1. Parse both versions of the document into an AST
2. Diff the AST at the block level: paragraphs, headings, lists, code blocks
3. Render the diff as semantic operations: moved section, reworded paragraph, added heading

Implementation:
- Version history via the `git2` Rust crate, reading the project's existing git history
- Diff view triggered from a file history panel, not a separate mode
- No red and green line noise. Structural changes rendered as readable document operations.

This feature does not exist in any current tool. It is the demo hook.

---

## Phase 4: Import Pipeline

Each importer is a standalone Rust module behind a common trait:

```rust
trait Importer {
    fn detect(path: &Path) -> bool;
    fn import(path: &Path, target: &Path) -> Result<ImportReport, Error>;
}
```

Every importer produces an `ImportReport` showing what was converted, what was skipped, and what needs manual review. Surface this as a summary UI after import completes.

### 4.1 Obsidian Importer

- Resolve `[[wiki-links]]` to relative Markdown links or preserve as configurable syntax
- Convert tags to frontmatter `tags` array
- Copy attachments into a normalized `/assets` directory
- Report any links that could not be resolved

### 4.2 Notion Importer

- Accept Notion's zip export format
- Flatten the nested folder structure intelligently
- Strip UUID suffixes from filenames
- Reconstruct the internal link graph from Notion's exported link format
- Clean up Notion inline styling artifacts

### 4.3 Bear Importer

- Parse Bear's tag syntax into frontmatter `tags` array
- Handle Bear's attachment references
- Preserve creation and modification dates as frontmatter fields

### 4.4 Raw Directory Importer

- Accept any directory of Markdown files
- Infer frontmatter schema from existing files
- Build the link graph from scratch
- Report structural issues found on import

---

## Phase 5: Export Pipeline

Each exporter follows the same pattern:

```rust
trait Exporter {
    fn export(project: &Project, options: ExportOptions) -> Result<ExportReport, Error>;
}
```

The export UI is a panel, not a dialog. Configure target, preview the output file tree, then export.

### 5.1 Free Tier Exports

- **Standard Markdown** — clean and normalized
- **GitHub Flavored Markdown** — GFM-compatible syntax normalization
- **Single-file HTML** — all assets inlined, renders anywhere without a build step
- **Obsidian vault** — exports to a target vault directory, wiki-link syntax configurable, attachments to the vault's attachment folder, frontmatter passes through untouched
- **Bear** — pushes via Bear's x-callback-url scheme with tags derived from frontmatter tags array
- **Raw directory copy** — resolved links, clean output

### 5.2 Pro Tier Exports

- **PDF** — full typography control: font selection, margins, heading styles, code block themes, page numbering. Not a browser print stylesheet.
- **Notion** — direct API integration mapping Skrive's document AST to Notion block types. Frontmatter fields map to Notion page properties. Requires a Notion API key stored locally.
- **Astro-ready** — correct frontmatter format, correct asset path handling, optional `astro.config` scaffold for new projects
- **Docusaurus-ready** — sidebar manifest generation, correct frontmatter keys
- **Next.js MDX-ready** — component import scaffolding, correct MDX frontmatter
- **ePub** — proper chapter structure for long-form documents
- **Custom render target** — user-defined export configuration via `.skrive.toml`

---

## Phase 6: Polish

### 6.1 Performance Targets

Internal hard targets, not marketing claims:

- Cold open to editor ready: under 1 second
- File switch: under 50ms
- Link graph update on save: under 100ms for projects up to 10,000 files
- PDF export of a 500-page document: under 10 seconds

### 6.2 The Aesthetic Bar

- One default theme shipped exceptionally before a theme system exists
- Warm off-white background in light mode, true dark in dark mode
- Careful typographic scale: a serif or refined sans for prose, monospace for code blocks that is not the system default
- Transitions on mode switch that feel physical
- The document should look good enough that you want to write in it

No theme system at launch. One theme done right.

### 6.3 Keyboard First

Every primary action has a keyboard shortcut. The mouse should never be required for any writing workflow. Document this from the start, not as an afterthought.

---

## Phase 7: Monetization

### The Model

One-time purchase. No subscription. No account required. No license server.

**Free forever:**
- Full editor
- All project intelligence: link graph, structural lint, structural diff, frontmatter system
- All free tier exports: Standard Markdown, GFM, Single-file HTML, Obsidian vault, Bear, raw directory
- Unlimited projects and files

**Pro — $49, one-time purchase:**
- PDF export with full typography control
- Notion API export
- Astro, Docusaurus, and Next.js MDX exports
- ePub export
- Custom render target configuration

### License Validation

Local cryptographic validation only. No network call ever.

Implementation:
- A license key scheme validated against a public key embedded in the binary
- The Rust core validates the key on startup and caches the result for the session
- No phone home, no activation server, no expiry
- Buy once, own forever including all future updates to pro export targets

This is non-negotiable. A license server would contradict the product's core philosophy.

### Feature Gating

Gate at the export command level in Rust. The frontend shows all export options always so users know exactly what they are unlocking. Attempting a pro export without a valid license shows a single clean upgrade prompt with a direct purchase link. No dark patterns, no nag screens in the editor itself.

### Distribution

- Direct download from `skrive.app`
- Signed and notarized macOS `.dmg`
- Windows `.msi` installer
- Linux `.AppImage`
- No App Store at launch. 30% cut and review latency are not acceptable for v1.
- Paddle for payment processing. Handles VAT automatically, supports one-time purchases natively.

---

## Launch

**Private beta targets:** Technical writers and developer advocates at software companies. People writing documentation at volume. People who feel the pain daily.

**Public launch:** Show HN with a screen recording showing three things:
1. The structural diff on a real document
2. The frontmatter system auto-updating fields
3. A full export pipeline from Skrive to Notion and to PDF

The product sells itself if those three things are shown clearly.

**One-line positioning:**

> Skrive. Write seriously.
