//! Project state and the in-memory model emitted to the frontend on open.
//!
//! The Rust core is the single source of truth for everything project-related.
//! On `open_project` we walk the directory, parse frontmatter from every
//! Markdown file, build the link graph, and hand the frontend an immutable
//! `ProjectManifest` snapshot. Subsequent updates flow through the file watcher
//! as targeted events — the frontend never re-scans.

use crate::error::{Error, Result};
use crate::frontmatter;
use crate::link_graph::{self, Edge, LinkGraph, LinkKind, LinkTarget};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

/// The complete snapshot returned by `open_project`. Paths are project-relative
/// and use forward slashes for consistency across platforms. The `schema`
/// field is derived from the parsed frontmatter of every file in `files`
/// by `infer_schema` and is what the frontmatter panel + autocomplete
/// system read against — the frontend caches it on the store rather than
/// hitting Rust on every keystroke.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub root: String,
    pub files: Vec<FileEntry>,
    pub schema: ProjectSchema,
}

/// Project-wide frontmatter schema, inferred from every file's frontmatter
/// during `open_project`. The shape is deliberately plain so the Phase 2.3
/// implementation (inline, static) can be replaced with an incremental or
/// watcher-driven one later without the wire protocol changing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSchema {
    pub file_count: usize,
    pub fields: BTreeMap<String, FieldInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    /// Number of files in the project that have this field at all.
    pub presence: usize,
    /// Distinct value types seen across files. Values are the JSON-style
    /// names `"string"`, `"number"`, `"boolean"`, `"null"`, `"array"`,
    /// `"object"`. Sorted for deterministic output.
    pub types: Vec<String>,
    /// Distinct scalar values seen across files, in insertion order.
    /// Populated only for fields whose values are all scalars (string /
    /// number / boolean / null) *and* the distinct count is ≤ 20. Larger
    /// sets and any field that ever saw a non-scalar value have an empty
    /// `known_values`, which the autocomplete layer interprets as
    /// "no suggestions to offer for this field's value".
    pub known_values: Vec<Value>,
}

/// A single Markdown file in the project, with its parsed frontmatter and the
/// links it points at.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Project-relative path with forward slashes.
    pub path: String,
    /// File name including extension.
    pub name: String,
    pub size_bytes: u64,
    /// Last modified time as Unix milliseconds, or `None` if unavailable.
    pub modified_ms: Option<i64>,
    pub frontmatter: Map<String, Value>,
    pub outgoing_links: Vec<String>,
}

/// Per-file content payload returned by `read_file`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub body: String,
    pub frontmatter: Map<String, Value>,
    pub modified_ms: Option<i64>,
}

/// Which history source drives the version-history panel for this
/// project. Mode is decided at `open_project` and is mutually exclusive:
/// a project with `.git/` at its root delegates to git; everything else
/// falls back to Skrive-managed checkpoints on disk.
///
/// Phase 3.3a plan §1.1; storage contract in
/// [`docs/checkpoint-storage.md`](../../docs/checkpoint-storage.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryMode {
    Git,
    Checkpoints,
}

/// Decide the history mode for a freshly opened project. `.git/` as a
/// directory is the normal repo case; `.git` as a *file* covers git
/// worktrees and submodules (the file points at the real gitdir).
/// Everything else is a Skrive-managed checkpoint project.
pub fn detect_history_mode(root: &Path) -> HistoryMode {
    if root.join(".git").exists() {
        HistoryMode::Git
    } else {
        HistoryMode::Checkpoints
    }
}

/// State for the currently open project. Held inside a `tokio::sync::Mutex`
/// behind `tauri::State` so commands can mutate it across `await` points.
#[derive(Debug)]
pub struct ProjectState {
    pub root: PathBuf,
    /// Populated during `scan` and kept current by the `note_*` methods.
    /// Read by Phase 3.1's backlinks, dead-links, and
    /// rename-with-references commands (Steps 2–6). The methods below
    /// are how filesystem-mutating commands report their changes back
    /// into the graph — never let the graph drift from what's on disk.
    pub link_graph: LinkGraph,
    /// History source — git if the project root is a repo, checkpoints
    /// otherwise. Decided once at `open_project` and then treated as
    /// immutable for the lifetime of the session: a user who runs
    /// `git init` mid-session closes and reopens the project to switch
    /// modes, which is rare enough not to need live re-detection.
    pub history_mode: HistoryMode,
}

impl ProjectState {
    /// Re-extract edges for `rel` from the given in-memory body and
    /// frontmatter. Called by `write_file` after a successful write and
    /// by `read_file` after a fresh read; both flows end with the Rust
    /// core holding a parsed representation of the file, so updating
    /// the graph is free.
    pub fn note_file_written(
        &mut self,
        rel: &Path,
        body: &str,
        frontmatter: &Map<String, Value>,
    ) {
        let parsed = crate::frontmatter::ParsedDocument {
            frontmatter: frontmatter.clone(),
            body: body.to_string(),
        };
        let edges = link_graph::extract(&parsed, rel);
        self.link_graph.set_links(&relpath_to_string(rel), edges);
    }

    /// Register a newly-created file in the graph. New files are empty,
    /// so the forward entry is an empty edge list — but installing it
    /// explicitly means `outgoing(rel)` returns `Some(&[])` instead of
    /// `None`, which is how "we know about this file" is represented.
    pub fn note_file_created(&mut self, rel: &Path) {
        self.link_graph.set_links(&relpath_to_string(rel), Vec::new());
    }

    /// Drop a deleted file from the graph. Backward edges pointing *at*
    /// this path are preserved — they represent other files that still
    /// link to the now-missing target, which is exactly the dead-link
    /// data Phase 3.2 will surface.
    pub fn note_file_deleted(&mut self, rel: &Path) {
        self.link_graph.forget(&relpath_to_string(rel));
    }

    /// Drop every file inside a deleted directory. Iterates the graph's
    /// forward keys and forgets every source whose path sits under
    /// `rel/`. Called by `delete_path` when the deleted target is a
    /// directory.
    pub fn note_directory_deleted(&mut self, rel: &Path) {
        let rel_str = relpath_to_string(rel);
        let prefix = format!("{}/", rel_str);
        let sources: Vec<String> = self
            .link_graph
            .iter()
            .map(|(k, _)| k.clone())
            .filter(|k| k.starts_with(&prefix))
            .collect();
        for s in sources {
            self.link_graph.forget(&s);
        }
    }
}

/// Threshold above which a field's `known_values` is cleared. Chosen so
/// free-form fields like `title` don't balloon the schema while legitimate
/// enum-like fields (status, draft, category) still fit comfortably.
const KNOWN_VALUES_THRESHOLD: usize = 20;

/// Infer a project-wide frontmatter schema from an already-parsed file
/// list. O(total number of frontmatter fields across the project), which
/// is effectively linear in file count since most frontmatter blocks
/// have a handful of entries.
pub fn infer_schema(files: &[FileEntry]) -> ProjectSchema {
    // Intermediate accumulator per field. We keep a separate
    // `known_values_abandoned` flag so once a field becomes too large
    // or sees a non-scalar value, subsequent values are ignored without
    // ever re-growing the vector.
    #[derive(Default)]
    struct Accum {
        presence: usize,
        types: Vec<String>,
        known_values: Vec<Value>,
        known_values_abandoned: bool,
    }

    let mut fields: BTreeMap<String, Accum> = BTreeMap::new();

    for file in files {
        for (key, value) in &file.frontmatter {
            let entry = fields.entry(key.clone()).or_default();
            entry.presence += 1;

            let type_name = value_type_name(value).to_string();
            if !entry.types.contains(&type_name) {
                entry.types.push(type_name);
            }

            if entry.known_values_abandoned {
                continue;
            }
            if !is_scalar(value) {
                entry.known_values.clear();
                entry.known_values_abandoned = true;
                continue;
            }
            if !entry.known_values.iter().any(|v| v == value) {
                entry.known_values.push(value.clone());
                if entry.known_values.len() > KNOWN_VALUES_THRESHOLD {
                    entry.known_values.clear();
                    entry.known_values_abandoned = true;
                }
            }
        }
    }

    let out_fields = fields
        .into_iter()
        .map(|(name, mut accum)| {
            accum.types.sort();
            (
                name,
                FieldInfo {
                    presence: accum.presence,
                    types: accum.types,
                    known_values: accum.known_values,
                },
            )
        })
        .collect();

    ProjectSchema {
        file_count: files.len(),
        fields: out_fields,
    }
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn is_scalar(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

/// Walk a directory, parse every Markdown file, and assemble the manifest plus
/// the link graph in a single pass.
pub fn scan(root: &Path) -> Result<(ProjectManifest, LinkGraph)> {
    let canonical_root = root.canonicalize()?;
    let mut files = Vec::new();
    let mut graph = LinkGraph::new();

    for entry in WalkDir::new(&canonical_root)
        .follow_links(false)
        .into_iter()
        // depth==0 is the root itself — let it pass even when its file
        // name starts with `.` (e.g. tempdirs on macOS). The hidden-dir
        // filter only applies to descendants.
        .filter_entry(|e| {
            e.depth() == 0
                || (!is_hidden(e.file_name()) && !is_noise_dir(e.file_name()))
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => return Err(Error::Io(e.to_string())),
        };
        if !entry.file_type().is_file() {
            continue;
        }
        if !is_markdown(entry.path()) {
            continue;
        }

        let rel = match entry.path().strip_prefix(&canonical_root) {
            Ok(p) => p.to_path_buf(),
            Err(_) => continue,
        };
        let rel_str = relpath_to_string(&rel);

        let source = std::fs::read_to_string(entry.path())?;
        let parsed = frontmatter::parse(&source)?;
        let edges = link_graph::extract(&parsed, &rel);
        let outgoing_links = edges_to_strings(&edges);
        graph.set_links(&rel_str, edges);

        let metadata = entry.metadata().map_err(|e| Error::Io(e.to_string()))?;
        files.push(FileEntry {
            path: rel_str,
            name: entry
                .file_name()
                .to_str()
                .map(str::to_string)
                .unwrap_or_default(),
            size_bytes: metadata.len(),
            modified_ms: system_time_to_ms(metadata.modified().ok()),
            frontmatter: parsed.frontmatter,
            outgoing_links,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));

    let schema = infer_schema(&files);

    Ok((
        ProjectManifest {
            root: canonical_root.to_string_lossy().into_owned(),
            files,
            schema,
        },
        graph,
    ))
}

/// Read a single Markdown file and return its parsed payload. Used by both
/// `read_file` (frontend command) and the watcher (when emitting refresh
/// events).
pub fn read(root: &Path, rel: &Path) -> Result<FileContent> {
    let absolute = resolve_within(root, rel)?;
    let source = std::fs::read_to_string(&absolute)?;
    let parsed = frontmatter::parse(&source)?;
    let metadata = std::fs::metadata(&absolute)?;
    Ok(FileContent {
        path: relpath_to_string(rel),
        body: parsed.body,
        frontmatter: parsed.frontmatter,
        modified_ms: system_time_to_ms(metadata.modified().ok()),
    })
}

/// Write a Markdown file inside the project root as a frontmatter block
/// followed by the body. The two pieces are passed separately because the
/// frontend edits them through two different surfaces — the editor owns
/// the body, the frontmatter panel owns the map — and we want a single
/// write call that commits both atomically.
///
/// An empty frontmatter map writes no `---` block at all. Parent
/// directories are created as needed. Path confinement is enforced by
/// `resolve_within`.
pub fn write(
    root: &Path,
    rel: &Path,
    body: &str,
    frontmatter: &Map<String, Value>,
) -> Result<()> {
    let absolute = resolve_within(root, rel)?;
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let contents = compose_file(body, frontmatter)?;
    std::fs::write(absolute, contents)?;
    Ok(())
}

/// Compose the exact bytes `write` would put on disk for the given
/// body + frontmatter pair. Exposed so the checkpoint writer (which
/// snapshots a post-save file) can obtain those same bytes without
/// re-reading the freshly-written file from disk.
pub fn compose_file(
    body: &str,
    frontmatter: &Map<String, Value>,
) -> Result<String> {
    let fm_block = frontmatter::serialize(frontmatter)?;
    let mut contents = String::with_capacity(fm_block.len() + body.len());
    contents.push_str(&fm_block);
    contents.push_str(body);
    Ok(contents)
}

/// Create a new empty Markdown file at the given project-relative path.
/// Refuses if the file already exists (to prevent silent overwrites) and
/// validates that `rel` stays inside the project root. Parent directories
/// are created as needed.
pub fn create_new_file(root: &Path, rel: &Path) -> Result<()> {
    if !is_markdown(rel) {
        return Err(Error::NotMarkdown);
    }

    // Reject absolute paths, root components, and any `..` traversal.
    for component in rel.components() {
        match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(Error::PathOutsideProject);
            }
            _ => {}
        }
    }

    let canonical_root = root.canonicalize()?;
    let absolute = canonical_root.join(rel);
    if absolute.exists() {
        return Err(Error::Io(format!("{} already exists", rel.display())));
    }

    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(absolute, "")?;
    Ok(())
}

// =========================== Project-wide search ===========================

/// Options accepted by `search`. `case_sensitive: false` is plain ASCII case
/// folding — enough for the dogfood content that drives this feature.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            case_sensitive: false,
        }
    }
}

/// A single hit inside a file. `line_number` is 1-indexed (what humans and
/// CodeMirror both want); `column` is the 0-indexed character offset into
/// `snippet` where the match begins.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line_number: u32,
    pub column: u32,
    pub match_length: u32,
    pub snippet: String,
}

/// Cap on total hits a single search returns. A pathological query (e.g.
/// searching for `.`) can otherwise fill the frontend's result list with
/// more rows than are useful. The cap is deliberately generous — the
/// command palette's 20-row cap is about attention, this one is about
/// IPC payload size.
const SEARCH_HIT_CAP: usize = 500;

// =========================== Backlinks / outgoing links ===========================

/// A single inbound reference to the queried file. `line` is 1-indexed
/// and `column` is a 0-indexed UTF-16 code-unit offset into the source
/// line — both match what CodeMirror and the rest of the frontend
/// expect (`PendingSelection`, `SearchHit`). `snippet` is the trimmed
/// source line, truncated to a readable width so the UI can render
/// backlink rows without layout surgery.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub snippet: String,
}

/// A single outbound link from the queried file. Same shape as
/// `Backlink` but named distinctly so command callers never confuse the
/// two — here `path` is the *target* file being linked to; in
/// `Backlink`, `path` is the source.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingLink {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub snippet: String,
}

/// One reference to the renamed file's old path. Same shape as
/// `Backlink` plus a `kind` field — the rename preview wants to show
/// which kind of markdown construct each rewrite touches (inline vs
/// wiki vs reference-definition), and Phase 3.1 Step 6's commit path
/// needs `kind` to know what part of the source line to rewrite.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub snippet: String,
    pub kind: LinkKind,
}

/// Payload returned by `preview_rename`. The modal renders
/// `references` as its main list and `definitionUpdates` as a small
/// "and N self-references inside the renamed file" footnote — the two
/// are presented distinctly so the primary "N references across M
/// files" count stays cross-file-accurate.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenamePreview {
    /// True when the proposed new path is already a known file in the
    /// project, or when `newPath == oldPath`. Either disables the
    /// Rename button and shows an inline error in the modal.
    pub target_exists: bool,
    /// Edges from files OTHER than the one being renamed. Each row is a
    /// cross-file write the Step 6 commit will perform.
    pub references: Vec<Reference>,
    /// Edges whose source is the renamed file itself — self-references
    /// inside the same file that need to be rewritten so the file's
    /// own links keep pointing at its new path. Covers inline self-links
    /// (`[home](a.md)`), self-referential wiki (`[[a]]`), and any
    /// `[label]: a.md` definitions that live inside the renamed file.
    pub definition_updates: Vec<Reference>,
}

/// Report returned by `rename_with_references` after a successful
/// rename. `filesWritten` lists every file whose contents changed —
/// the frontend uses it to refresh open tabs and stamp watcher-echo
/// suppression. `referencesUpdated` is the total edit count, surfaced
/// in the post-rename toast.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenameReport {
    pub files_written: Vec<String>,
    pub references_updated: u32,
}

/// A link whose target doesn't resolve to a file in the project. Emitted
/// by `get_dead_links` and consumed in Phase 3.2 by the lint engine.
///
/// `target` is the *unresolved* display form — for relative targets it's
/// the project-relative path as the link wrote it; for wiki targets it's
/// the full `[[Name]]` string, so a lint row can render the user-facing
/// shape without reconstruction. `kind` lets the lint surface style
/// relative-path dead links differently from wiki dead links.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeadLink {
    pub source_path: String,
    pub target: String,
    pub line: u32,
    pub column: u32,
    pub snippet: String,
    pub kind: LinkKind,
}

/// Readable-width cap for snippets. The backlinks panel renders one row
/// per hit with a fixed-size line, so showing the whole source line is
/// usually too wide. 160 characters fits the common case without
/// truncating short lines and still fits a typical panel width.
const SNIPPET_CAP_CHARS: usize = 160;

/// Collect backlinks to `target_relpath`. Reads every source file in the
/// graph's backward set, re-parses its body to strip frontmatter (so
/// byte offsets line up with the edges' body-relative ranges), and
/// emits one row per matching edge. Returns an empty vector when the
/// target isn't in the backward map — that covers both "nothing links
/// here" and "file doesn't exist in the project" with the same UI.
pub fn collect_backlinks(state: &ProjectState, target_relpath: &str) -> Result<Vec<Backlink>> {
    let Some(sources) = state.link_graph.incoming(target_relpath) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for source in sources {
        let Some(edges) = state.link_graph.outgoing(source) else {
            continue;
        };

        // Read the source body fresh. We don't cache file contents in
        // the graph (they'd balloon memory for zero runtime benefit on
        // a feature the user triggers rarely), so a per-source disk
        // read is the cost of backlinks.
        let Some(body) = read_source_body(&state.root, source) else {
            continue;
        };

        for edge in edges {
            let crate::link_graph::LinkTarget::Relative(t) = &edge.target else {
                continue;
            };
            if t != target_relpath {
                continue;
            }
            let (snippet, column_utf16) = build_row(&body, edge.line, edge.column);
            out.push(Backlink {
                path: source.clone(),
                line: edge.line + 1,
                column: column_utf16,
                snippet,
            });
        }
    }

    // Sort for deterministic UI ordering: by path, then line, then
    // column. Same pattern as search results.
    out.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.line.cmp(&b.line))
            .then(a.column.cmp(&b.column))
    });
    Ok(out)
}

/// Collect outgoing links from `source_relpath`. Same shape as
/// `collect_backlinks` but keyed on source — used by Step 3's dead-link
/// detection and any future "show what this file references" UI.
pub fn collect_outgoing_links(
    state: &ProjectState,
    source_relpath: &str,
) -> Result<Vec<OutgoingLink>> {
    let Some(edges) = state.link_graph.outgoing(source_relpath) else {
        return Ok(Vec::new());
    };

    let Some(body) = read_source_body(&state.root, source_relpath) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for edge in edges {
        let target_str = match &edge.target {
            crate::link_graph::LinkTarget::Relative(p) => p.clone(),
            // Wiki links aren't project-relative paths, so they can't
            // drive the dead-link check the way inline / reference
            // links can. Skip until filename resolution lands.
            crate::link_graph::LinkTarget::Wiki(_) => continue,
        };
        let (snippet, column_utf16) = build_row(&body, edge.line, edge.column);
        out.push(OutgoingLink {
            path: target_str,
            line: edge.line + 1,
            column: column_utf16,
            snippet,
        });
    }
    // Already in document order (edges are pushed in the order
    // `extract` produces them), but sort for stability.
    out.sort_by(|a, b| a.line.cmp(&b.line).then(a.column.cmp(&b.column)));
    Ok(out)
}

/// Rename `old_path` to `new_path` and rewrite every inbound reference
/// across the project. Returns the list of files whose contents were
/// changed along with the total edit count.
///
/// The order of operations matters: we build every edit plan FIRST
/// (while the graph still reflects pre-rename state), THEN `fs::rename`,
/// THEN apply per-file edits to the on-disk bodies, THEN update the
/// in-memory graph. A failure during step 3 produces a partial
/// application — we log and return an error rather than attempt a
/// rollback, because the user's confirmation modal has already shown
/// them the intended changes and a silent half-rollback would be the
/// surprise we're trying to avoid.
///
/// What gets rewritten per kind:
/// - `Inline` — replaces the URL slice inside `[text](url)` with the new
///   relative path, computed from the source file's directory.
/// - `Wiki` — replaces the inner name inside `[[Name]]` with the new
///   file's stem. Filename-based resolution matches how the reader
///   resolves them.
/// - `ReferenceDefinition` — replaces the target inside
///   `[label]: target` with the new relative path.
/// - `ReferenceUse` — left alone. Uses reference the label, not the
///   path; the definition's rewrite is enough to re-point them.
pub fn rename_with_references(
    state: &mut ProjectState,
    old_path: &str,
    new_path: &str,
) -> Result<RenameReport> {
    if old_path == new_path {
        return Err(Error::Io(
            "rename target must differ from the current path".into(),
        ));
    }

    // Path guards. Old path must exist and be inside the project; new
    // path must be markdown, inside the project, and not already exist.
    // We avoid `resolve_within` for the new path because it canonicalizes
    // the parent directory, which collapses intermediate segments when
    // the parent doesn't exist yet (the case for renames into fresh
    // subdirectories like `docs/`). `create_new_file`'s pattern is the
    // right shape: reject escapes component-by-component, then build
    // the absolute path without canonicalizing the nonexistent parent.
    let old_abs = resolve_existing_within(&state.root, Path::new(old_path))?;
    if !is_markdown(Path::new(old_path)) || !is_markdown(Path::new(new_path)) {
        return Err(Error::NotMarkdown);
    }
    for component in Path::new(new_path).components() {
        match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(Error::PathOutsideProject);
            }
            _ => {}
        }
    }
    let canonical_root = state.root.canonicalize()?;
    let new_abs = canonical_root.join(new_path);
    if new_abs.exists() {
        return Err(Error::Io(format!("{} already exists", new_path)));
    }

    let old_stem_lower = Path::new(old_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase());
    let new_stem = Path::new(new_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .ok_or_else(|| Error::Io(format!("invalid target name: {}", new_path)))?;

    // Build the edit plan before any mutation. `SourceEdit.source_path`
    // is the *pre-rename* project-relative path; for the renamed file
    // itself we remap to `new_path` when we do the write.
    struct SourceEdit {
        source_path: String,
        edits: Vec<(Range<usize>, String)>,
    }
    let mut plans: Vec<SourceEdit> = Vec::new();
    let mut total_edits: u32 = 0;

    for (source, edges) in state.link_graph.iter() {
        let mut per_file: Vec<(Range<usize>, String)> = Vec::new();
        for edge in edges {
            if edge.kind == LinkKind::ReferenceUse {
                // Uses reference the label, not the path. The definition's
                // rewrite is what re-points them.
                continue;
            }
            let matches = match &edge.target {
                LinkTarget::Relative(p) => p == old_path,
                LinkTarget::Wiki(name) => match &old_stem_lower {
                    Some(stem) => name.to_lowercase() == *stem,
                    None => false,
                },
            };
            if !matches {
                continue;
            }
            let replacement = match edge.kind {
                LinkKind::Inline | LinkKind::ReferenceDefinition => {
                    relative_path(source, new_path)
                }
                LinkKind::Wiki => new_stem.clone(),
                LinkKind::ReferenceUse => continue,
            };
            per_file.push((edge.byte_range.clone(), replacement));
            total_edits += 1;
        }
        if !per_file.is_empty() {
            plans.push(SourceEdit {
                source_path: source.clone(),
                edits: per_file,
            });
        }
    }

    let renamed_has_self_edits = plans.iter().any(|p| p.source_path == old_path);

    // Step 3 proper: rename the file on disk. From this point onward a
    // failure is a partial application. Create the target's parent
    // directory if it's a fresh subpath so `fs::rename` doesn't fail
    // for missing intermediates.
    if let Some(parent) = new_abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&old_abs, &new_abs)?;

    let mut files_written: Vec<String> = Vec::with_capacity(plans.len() + 1);

    for plan in plans {
        // The renamed file's self-edits apply to content now living at
        // `new_path`; everything else applies to its original path.
        let effective_path = if plan.source_path == old_path {
            new_path.to_string()
        } else {
            plan.source_path.clone()
        };
        let rel = PathBuf::from(&effective_path);

        let absolute = resolve_within(&state.root, &rel)?;
        let raw = std::fs::read_to_string(&absolute)?;
        let parsed = frontmatter::parse(&raw)?;
        let mut body = parsed.body;

        // Back-to-front so earlier ranges don't shift under later edits.
        let mut edits = plan.edits;
        edits.sort_by(|a, b| b.0.start.cmp(&a.0.start));
        for (range, replacement) in edits {
            body.replace_range(range, &replacement);
        }

        write(&state.root, &rel, &body, &parsed.frontmatter)?;

        if plan.source_path == old_path {
            // The renamed file's graph entry moves with it.
            state.link_graph.forget(old_path);
        }
        state.note_file_written(&rel, &body, &parsed.frontmatter);
        files_written.push(effective_path);
    }

    // If the renamed file had no self-references we still need to move
    // its graph entry from old_path to new_path so subsequent commands
    // (backlinks, dead-links, a future second rename) see the correct
    // key. Content is unchanged, so we don't add it to files_written —
    // refreshing open tabs for an unchanged file would risk showing the
    // "keep yours / reload" prompt spuriously.
    if !renamed_has_self_edits {
        let rel = PathBuf::from(new_path);
        let absolute = resolve_within(&state.root, &rel)?;
        let raw = std::fs::read_to_string(&absolute)?;
        let parsed = frontmatter::parse(&raw)?;
        state.link_graph.forget(old_path);
        state.note_file_written(&rel, &parsed.body, &parsed.frontmatter);
    }

    Ok(RenameReport {
        files_written,
        references_updated: total_edits,
    })
}

/// Compute the project-relative-ish path the rewriter should emit as a
/// link target in a file at `source_relpath` pointing at `target_relpath`.
///
/// Both inputs are project-relative with forward slashes. The output is
/// the shortest path that resolves to `target_relpath` from the source
/// file's directory: a sibling becomes a bare filename, a file in the
/// same subtree drops the common prefix, a file elsewhere gets `../`
/// prefixes back to the common ancestor.
///
/// Called by `rename_with_references` for inline and reference-style
/// edges — both kinds write paths that resolve relative to the source's
/// directory, same as how the reader parses them.
fn relative_path(source_relpath: &str, target_relpath: &str) -> String {
    let source_dir: Vec<&str> = {
        let mut segs: Vec<&str> = source_relpath.split('/').filter(|s| !s.is_empty()).collect();
        segs.pop(); // drop the filename
        segs
    };
    let target_segs: Vec<&str> = target_relpath.split('/').filter(|s| !s.is_empty()).collect();

    let common = source_dir
        .iter()
        .zip(target_segs.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let ups = source_dir.len() - common;
    let downs = &target_segs[common..];

    let mut out: Vec<String> = Vec::with_capacity(ups + downs.len());
    for _ in 0..ups {
        out.push("..".to_string());
    }
    for d in downs {
        out.push((*d).to_string());
    }
    if out.is_empty() {
        // Source and target are the same file. This shouldn't happen in
        // practice — rename validates `old != new` up front — but emit
        // the filename alone as the safest fallback.
        return target_segs.last().copied().unwrap_or("").to_string();
    }
    out.join("/")
}

/// Walk every edge in the graph and emit one `DeadLink` per edge whose
/// target isn't resolvable. A relative target is considered live iff
/// it appears as a forward-map key (which is true of every file we've
/// scanned or `note_file_*`-tracked). A wiki target is considered live
/// iff any known file's basename (stem, case-insensitive) matches.
///
/// The resolver is deliberately best-effort — Phase 3.1 doesn't ship
/// click-to-navigate for wiki links, and this command returns the same
/// matches that resolver will eventually use, so dead-link detection
/// and navigation stay consistent.
pub fn collect_dead_links(state: &ProjectState) -> Result<Vec<DeadLink>> {
    // Cache lowercase stems once so the per-edge wiki lookup is O(1).
    // `file_stem` strips only the final extension — exactly what we
    // want for `[[Other Note]]` → `Other Note.md`.
    let known_stems: BTreeSet<String> = state
        .link_graph
        .iter()
        .filter_map(|(path, _)| {
            Path::new(path)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase())
        })
        .collect();

    let mut out: Vec<DeadLink> = Vec::new();

    for (source, edges) in state.link_graph.iter() {
        // Defer the disk read until we hit a dead edge — most files in a
        // well-maintained project have zero, and paying per-source for
        // files with no problems would double the cost of the common
        // case.
        let mut body: Option<String> = None;

        for edge in edges {
            let (resolves, target_display) = match &edge.target {
                LinkTarget::Relative(p) => {
                    // A target file is known iff the graph's forward map
                    // has it. `note_file_created` installs an empty
                    // entry for new files, so this covers the just-
                    // created, never-edited case too.
                    let live = state.link_graph.outgoing(p).is_some();
                    (live, p.clone())
                }
                LinkTarget::Wiki(name) => {
                    let stem = name.to_lowercase();
                    let live = known_stems.contains(&stem);
                    (live, format!("[[{}]]", name))
                }
            };
            if resolves {
                continue;
            }

            if body.is_none() {
                body = read_source_body(&state.root, source);
            }
            let Some(ref b) = body else {
                // File vanished between the scan and now. Nothing to
                // render; drop the edge rather than emit a snippet-less
                // row.
                continue;
            };
            let (snippet, column_utf16) = build_row(b, edge.line, edge.column);
            out.push(DeadLink {
                source_path: source.clone(),
                target: target_display,
                line: edge.line + 1,
                column: column_utf16,
                snippet,
                kind: edge.kind,
            });
        }
    }

    out.sort_by(|a, b| {
        a.source_path
            .cmp(&b.source_path)
            .then(a.line.cmp(&b.line))
            .then(a.column.cmp(&b.column))
    });
    Ok(out)
}

/// Build the preview payload for renaming `old_path` to `new_path`.
/// Read-only — no filesystem writes happen here. The Rename button
/// commits via Phase 3.1 Step 6's `rename_with_references` command.
///
/// Covers three edge shapes:
///
/// - **Inline and reference-definition targets** pointing at `old_path`.
///   Tracked in the graph's backward map and surfaced via a reuse of
///   the same forward-iteration used by backlinks.
/// - **Wiki targets** (`[[stem]]`) whose case-insensitive stem matches
///   `old_path`'s stem. Wiki edges live in forward only — no backward
///   entry — so we sweep every source's edges and filter.
/// - **Self-references inside the renamed file** are partitioned into
///   `definition_updates` so the primary "N references across M files"
///   count stays honest.
pub fn preview_rename(
    state: &ProjectState,
    old_path: &str,
    new_path: &str,
) -> Result<RenamePreview> {
    // target_exists check: a name collision is either a known graph
    // source, a raw file on disk we missed (e.g. non-Markdown), or the
    // trivial "no-op rename" where the new path equals the old. Any of
    // those disables the commit.
    let target_exists = if new_path == old_path {
        true
    } else if state.link_graph.outgoing(new_path).is_some() {
        true
    } else {
        state.root.join(new_path).exists()
    };

    // Precompute the old file's stem once for wiki matching. Wiki links
    // resolve by filename stem case-insensitively; if the renamed file
    // has no stem (empty path, weird input), no wiki edge can match.
    let old_stem = Path::new(old_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase());

    let mut references: Vec<Reference> = Vec::new();
    let mut self_updates: Vec<Reference> = Vec::new();

    for (source, edges) in state.link_graph.iter() {
        // Lazy-load source body; only pay the disk read if this file
        // actually references the renamed target.
        let mut body: Option<String> = None;

        for edge in edges {
            let matches = match &edge.target {
                LinkTarget::Relative(p) => p == old_path,
                LinkTarget::Wiki(name) => match &old_stem {
                    Some(stem) => name.to_lowercase() == *stem,
                    None => false,
                },
            };
            if !matches {
                continue;
            }

            if body.is_none() {
                body = read_source_body(&state.root, source);
            }
            let Some(ref b) = body else {
                continue;
            };
            let (snippet, column_utf16) = build_row(b, edge.line, edge.column);
            let row = Reference {
                path: source.clone(),
                line: edge.line + 1,
                column: column_utf16,
                snippet,
                kind: edge.kind,
            };
            if source == old_path {
                self_updates.push(row);
            } else {
                references.push(row);
            }
        }
    }

    references.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.line.cmp(&b.line))
            .then(a.column.cmp(&b.column))
    });
    self_updates.sort_by(|a, b| a.line.cmp(&b.line).then(a.column.cmp(&b.column)));

    Ok(RenamePreview {
        target_exists,
        references,
        definition_updates: self_updates,
    })
}

fn read_source_body(root: &Path, source_relpath: &str) -> Option<String> {
    let absolute = resolve_within(root, Path::new(source_relpath)).ok()?;
    let raw = std::fs::read_to_string(absolute).ok()?;
    frontmatter::parse(&raw).ok().map(|p| p.body)
}

fn build_row(body: &str, line_idx: u32, byte_col: u32) -> (String, u32) {
    let (line_text, column_utf16) = line_and_utf16_column(body, line_idx, byte_col);
    let snippet = truncate_snippet(&line_text, SNIPPET_CAP_CHARS);
    (snippet, column_utf16)
}

/// Extract the line at `line_idx` (0-indexed) and convert `byte_col` to
/// a UTF-16 code-unit column within that line. Returns an empty string
/// and 0 if the line index is past the document.
fn line_and_utf16_column(body: &str, line_idx: u32, byte_col: u32) -> (String, u32) {
    let mut start = 0usize;
    for _ in 0..line_idx {
        match body[start..].find('\n') {
            Some(offset) => start += offset + 1,
            None => return (String::new(), 0),
        }
    }
    let end = body[start..]
        .find('\n')
        .map(|o| start + o)
        .unwrap_or(body.len());
    let line_slice = body[start..end].trim_end_matches('\r');

    let target = byte_col as usize;
    let mut utf16 = 0u32;
    let mut bytes = 0usize;
    for ch in line_slice.chars() {
        if bytes >= target {
            break;
        }
        utf16 += ch.len_utf16() as u32;
        bytes += ch.len_utf8();
    }
    (line_slice.to_string(), utf16)
}

/// Trim surrounding whitespace and truncate to at most `cap` characters,
/// appending an ellipsis when cut. Character-count aware so we never
/// split inside a multi-byte sequence.
fn truncate_snippet(line: &str, cap: usize) -> String {
    let trimmed = line.trim();
    let count = trimmed.chars().count();
    if count <= cap {
        return trimmed.to_string();
    }
    let keep: String = trimmed.chars().take(cap.saturating_sub(1)).collect();
    format!("{}…", keep)
}

/// Walk the project and collect matches across every Markdown file.
///
/// Reuses the same walker filter as `scan` — hidden files and directories
/// are skipped; non-Markdown files are skipped because the manifest only
/// knows about Markdown and search results that can't be opened are noise.
/// Naive line-by-line scan is fine for dogfood-scale projects; TODO: swap
/// in `grep-searcher` if it becomes the bottleneck.
pub fn search(
    root: &Path,
    query: &str,
    options: SearchOptions,
) -> Result<Vec<SearchHit>> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let canonical_root = root.canonicalize()?;
    let needle_owned: String;
    let needle: &str = if options.case_sensitive {
        query
    } else {
        needle_owned = query.to_lowercase();
        &needle_owned
    };

    let mut hits: Vec<SearchHit> = Vec::new();

    'walker: for entry in WalkDir::new(&canonical_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || (!is_hidden(e.file_name()) && !is_noise_dir(e.file_name()))
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() || !is_markdown(entry.path()) {
            continue;
        }

        let rel = match entry.path().strip_prefix(&canonical_root) {
            Ok(p) => p.to_path_buf(),
            Err(_) => continue,
        };
        let rel_str = relpath_to_string(&rel);

        let source = match std::fs::read_to_string(entry.path()) {
            Ok(s) => s,
            Err(_) => continue,
        };

        for (line_idx, line) in source.lines().enumerate() {
            // Build a search-space copy of the line. For case-insensitive
            // matches we lowercase; for ASCII content (our dogfood case)
            // this preserves byte offsets so we can reuse them against
            // the original line when emitting snippets.
            let lowered_line: String;
            let search_line: &str = if options.case_sensitive {
                line
            } else {
                lowered_line = line.to_lowercase();
                &lowered_line
            };

            let mut cursor = 0usize;
            while cursor <= search_line.len() {
                let slice = match search_line.get(cursor..) {
                    Some(s) => s,
                    None => break,
                };
                let pos = match slice.find(needle) {
                    Some(p) => p,
                    None => break,
                };
                let abs = cursor + pos;
                let column_chars =
                    search_line.get(..abs).map(|s| s.chars().count()).unwrap_or(0);
                let match_char_len = needle.chars().count();
                hits.push(SearchHit {
                    path: rel_str.clone(),
                    line_number: (line_idx as u32) + 1,
                    column: column_chars as u32,
                    match_length: match_char_len as u32,
                    snippet: line.to_string(),
                });
                if hits.len() >= SEARCH_HIT_CAP {
                    break 'walker;
                }
                let advance = needle.len().max(1);
                cursor = abs + advance;
            }
        }
    }

    // Stable sort: by path, then by line, then by column. The frontend
    // groups by path so a stable order makes scanning easier.
    hits.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.line_number.cmp(&b.line_number))
            .then(a.column.cmp(&b.column))
    });

    Ok(hits)
}

/// Confine an existing path (file or directory) to `root`. Unlike
/// `resolve_within`, this accepts non-Markdown paths because the caller —
/// the sidebar's delete flow — needs to trash folders and (eventually)
/// other file types. Refuses to return the project root itself so a
/// stray "delete this row" on the sidebar's implicit root can't wipe
/// the project.
pub fn resolve_existing_within(root: &Path, rel: &Path) -> Result<PathBuf> {
    for component in rel.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(Error::PathOutsideProject);
            }
            _ => {}
        }
    }
    let canonical_root = root.canonicalize()?;
    let absolute = canonical_root.join(rel).canonicalize()?;
    if !absolute.starts_with(&canonical_root) {
        return Err(Error::PathOutsideProject);
    }
    if absolute == canonical_root {
        return Err(Error::PathOutsideProject);
    }
    Ok(absolute)
}

/// Resolve the project root for a file that Skrive was asked to open from
/// outside (Finder, Explorer, Linux file manager, CLI). Walks up from the
/// file's parent directory, checking each ancestor for `.skrive.toml` or
/// `.git`. The first ancestor that has either becomes the project root.
/// If the walk hits the filesystem root, the file's parent dir becomes an
/// ad-hoc project root — a folder full of Markdown gets to act like a
/// project even without the marker files.
///
/// Returns `(project_root, relative_file_path)`. The caller then opens
/// the project via the normal flow and focuses the given file.
pub fn resolve_project_for_file(file_path: &Path) -> Result<(PathBuf, PathBuf)> {
    let absolute = file_path.canonicalize()?;
    if !absolute.is_file() {
        return Err(Error::Io(format!(
            "{} is not a file",
            absolute.display()
        )));
    }
    let parent = absolute.parent().ok_or(Error::PathOutsideProject)?;

    // Walk up looking for project markers.
    let mut candidate = parent.to_path_buf();
    let mut found_root: Option<PathBuf> = None;
    loop {
        if candidate.join(".skrive.toml").exists() || candidate.join(".git").exists() {
            found_root = Some(candidate.clone());
            break;
        }
        match candidate.parent() {
            Some(p) if p != candidate => candidate = p.to_path_buf(),
            _ => break,
        }
    }

    let root = found_root.unwrap_or_else(|| parent.to_path_buf());
    let rel = absolute
        .strip_prefix(&root)
        .map_err(|_| Error::PathOutsideProject)?
        .to_path_buf();
    Ok((root, rel))
}

/// Create a new directory at the given project-relative path. Parent
/// directories are created as needed. Refuses if the path already exists.
/// Path confinement uses the same rules as `create_new_file`.
pub fn create_new_directory(root: &Path, rel: &Path) -> Result<()> {
    for component in rel.components() {
        match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(Error::PathOutsideProject);
            }
            _ => {}
        }
    }
    let canonical_root = root.canonicalize()?;
    let absolute = canonical_root.join(rel);
    if absolute.exists() {
        return Err(Error::Io(format!("{} already exists", rel.display())));
    }
    std::fs::create_dir_all(&absolute)?;
    Ok(())
}

/// Confine `rel` to `root`. Symlinks and `..` traversal that would escape the
/// project are rejected. The returned path is absolute.
pub fn resolve_within(root: &Path, rel: &Path) -> Result<PathBuf> {
    if !is_markdown(rel) {
        return Err(Error::NotMarkdown);
    }
    let candidate = root.join(rel);

    // We canonicalize the parent directory rather than the candidate itself so
    // we can write to files that don't exist yet.
    let parent = candidate.parent().ok_or(Error::PathOutsideProject)?;
    let canonical_parent = if parent.exists() {
        parent.canonicalize()?
    } else {
        // The parent doesn't exist yet — fall back to canonicalizing the root
        // and joining the literal relative path. This still blocks `..` escapes
        // because we re-validate the joined result below.
        root.canonicalize()?
    };
    let canonical_root = root.canonicalize()?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(Error::PathOutsideProject);
    }

    let file_name = candidate.file_name().ok_or(Error::PathOutsideProject)?;
    Ok(canonical_parent.join(file_name))
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_str().map(|s| s.starts_with('.')).unwrap_or(false)
}

/// Well-known build-output and dependency directories that bury the
/// Markdown we actually care about. This is a deliberate stopgap — the
/// long-term answer is `.gitignore`-aware walking (open question P3),
/// but a hardcoded list covers 95% of dogfood cases at zero cost and
/// without touching the dependency tree. If a user legitimately wants
/// to see Markdown inside one of these folders, they'll tell us.
fn is_noise_dir(name: &std::ffi::OsStr) -> bool {
    matches!(
        name.to_str(),
        Some("node_modules")
            | Some("target")
            | Some("dist")
            | Some("build")
            | Some("__pycache__")
            | Some("venv")
    )
}

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md") | Some("markdown")
    )
}

fn relpath_to_string(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

fn system_time_to_ms(time: Option<SystemTime>) -> Option<i64> {
    let duration = time?.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_millis()).ok()
}

/// Serialize edges to the string list the frontend's `FileEntry.outgoing_links`
/// expects. Deduplicated — two edges to the same target collapse into one
/// entry (a file that references `other.md` three times still only lists
/// `other.md` once on the manifest). Reference-style definitions are
/// included too; they live in the same file and point at the same target
/// as their uses, but callers that want "what files link out of this one"
/// expect the unique target set.
fn edges_to_strings(edges: &[Edge]) -> Vec<String> {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for edge in edges {
        let key = match &edge.target {
            LinkTarget::Relative(p) => p.clone(),
            LinkTarget::Wiki(name) => format!("[[{}]]", name),
        };
        seen.insert(key);
    }
    seen.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relpath_normalizes_separators() {
        assert_eq!(
            relpath_to_string(Path::new("a").join("b.md").as_path()),
            "a/b.md".to_string()
        );
    }

    #[test]
    fn rejects_non_markdown() {
        let root = std::env::temp_dir();
        let err = resolve_within(&root, Path::new("foo.txt")).unwrap_err();
        assert!(matches!(err, Error::NotMarkdown));
    }

    // ================== infer_schema tests ==================
    //
    // These use synthetic `FileEntry` values rather than walking a real
    // directory because `infer_schema` takes an already-parsed file list.
    // Keeping the tests at that boundary lets them stay fast and focused.

    fn entry(path: &str, frontmatter: Map<String, Value>) -> FileEntry {
        FileEntry {
            path: path.to_string(),
            name: path.to_string(),
            size_bytes: 0,
            modified_ms: None,
            frontmatter,
            outgoing_links: Vec::new(),
        }
    }

    fn fm(pairs: &[(&str, Value)]) -> Map<String, Value> {
        let mut m = Map::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    #[test]
    fn schema_counts_presence_across_files() {
        let files = vec![
            entry("a.md", fm(&[("title", Value::String("A".into()))])),
            entry("b.md", fm(&[("title", Value::String("B".into()))])),
            entry("c.md", fm(&[])),
        ];
        let schema = infer_schema(&files);
        assert_eq!(schema.file_count, 3);
        assert_eq!(schema.fields["title"].presence, 2);
    }

    #[test]
    fn schema_detects_boolean_enum_known_values() {
        let files = vec![
            entry("a.md", fm(&[("draft", Value::Bool(true))])),
            entry("b.md", fm(&[("draft", Value::Bool(false))])),
            entry("c.md", fm(&[("draft", Value::Bool(true))])),
        ];
        let schema = infer_schema(&files);
        let draft = &schema.fields["draft"];
        assert_eq!(draft.presence, 3);
        assert_eq!(draft.types, vec!["boolean"]);
        assert_eq!(draft.known_values.len(), 2);
        assert!(draft.known_values.contains(&Value::Bool(true)));
        assert!(draft.known_values.contains(&Value::Bool(false)));
    }

    #[test]
    fn schema_clears_known_values_past_threshold() {
        let files: Vec<FileEntry> = (0..25)
            .map(|i| {
                entry(
                    &format!("{}.md", i),
                    fm(&[("title", Value::String(format!("Title {}", i)))]),
                )
            })
            .collect();
        let schema = infer_schema(&files);
        let title = &schema.fields["title"];
        assert_eq!(title.presence, 25);
        assert_eq!(title.types, vec!["string"]);
        assert!(
            title.known_values.is_empty(),
            "25 distinct values should exceed the threshold and clear known_values"
        );
    }

    #[test]
    fn schema_arrays_never_populate_known_values() {
        let files = vec![
            entry(
                "a.md",
                fm(&[(
                    "tags",
                    Value::Array(vec![Value::String("a".into())]),
                )]),
            ),
            entry(
                "b.md",
                fm(&[(
                    "tags",
                    Value::Array(vec![Value::String("b".into())]),
                )]),
            ),
        ];
        let schema = infer_schema(&files);
        let tags = &schema.fields["tags"];
        assert_eq!(tags.types, vec!["array"]);
        assert!(tags.known_values.is_empty());
    }

    #[test]
    fn schema_reports_multiple_types_when_field_is_inconsistent() {
        let files = vec![
            entry("a.md", fm(&[("value", Value::String("one".into()))])),
            entry("b.md", fm(&[("value", Value::Bool(true))])),
        ];
        let schema = infer_schema(&files);
        let value = &schema.fields["value"];
        assert_eq!(value.presence, 2);
        // Types are sorted for deterministic output.
        assert_eq!(value.types, vec!["boolean", "string"]);
        // Mixed types of scalars are still allowed to populate known_values
        // because the cap is about size, not homogeneity.
        assert_eq!(value.known_values.len(), 2);
    }

    #[test]
    fn schema_non_scalar_poisons_known_values() {
        // Once a field has seen any non-scalar (array, object), further
        // scalars for the same field must not repopulate known_values.
        let files = vec![
            entry("a.md", fm(&[("mixed", Value::String("a".into()))])),
            entry(
                "b.md",
                fm(&[(
                    "mixed",
                    Value::Array(vec![Value::String("x".into())]),
                )]),
            ),
            entry("c.md", fm(&[("mixed", Value::String("c".into()))])),
        ];
        let schema = infer_schema(&files);
        let mixed = &schema.fields["mixed"];
        assert_eq!(mixed.presence, 3);
        assert_eq!(mixed.types, vec!["array", "string"]);
        assert!(mixed.known_values.is_empty());
    }

    #[test]
    fn schema_empty_file_list_returns_empty_schema() {
        let schema = infer_schema(&[]);
        assert_eq!(schema.file_count, 0);
        assert!(schema.fields.is_empty());
    }

    // ================== search tests ==================

    fn write_temp_project(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        for (name, body) in files {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, body).unwrap();
        }
        dir
    }

    #[test]
    fn search_finds_case_insensitive_match_across_files() {
        let dir = write_temp_project(&[
            ("a.md", "hello world\nsome other line\n"),
            ("b.md", "Hello again\nand another\n"),
            ("ignored.txt", "hello from txt"),
        ]);
        let hits = search(
            dir.path(),
            "hello",
            SearchOptions {
                case_sensitive: false,
            },
        )
        .unwrap();
        assert_eq!(hits.len(), 2, "one hit per md file, none in .txt");
        assert_eq!(hits[0].path, "a.md");
        assert_eq!(hits[0].line_number, 1);
        assert_eq!(hits[0].column, 0);
        assert_eq!(hits[1].path, "b.md");
        assert_eq!(hits[1].line_number, 1);
    }

    #[test]
    fn search_case_sensitive_flag_respects_case() {
        let dir = write_temp_project(&[("a.md", "hello\nHello\nHELLO\n")]);
        let hits = search(
            dir.path(),
            "Hello",
            SearchOptions {
                case_sensitive: true,
            },
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line_number, 2);
    }

    #[test]
    fn search_reports_multiple_hits_on_same_line() {
        let dir = write_temp_project(&[("a.md", "foo bar foo\n")]);
        let hits = search(
            dir.path(),
            "foo",
            SearchOptions::default(),
        )
        .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].column, 0);
        assert_eq!(hits[1].column, 8);
    }

    #[test]
    fn search_empty_query_returns_no_hits() {
        let dir = write_temp_project(&[("a.md", "content\n")]);
        let hits = search(dir.path(), "", SearchOptions::default()).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn scan_skips_noise_directories() {
        // A realistic dogfood accident: the user points Skrive at a
        // code repo that happens to contain Markdown in its dependency
        // tree. `node_modules/foo/README.md` should not land in the
        // manifest.
        let dir = write_temp_project(&[
            ("notes.md", "# hi\n"),
            ("node_modules/foo/README.md", "# foo\n"),
            ("target/doc/rustdoc.md", "# rustdoc\n"),
            ("dist/release-notes.md", "# release\n"),
            ("venv/lib/package/README.md", "# pkg\n"),
        ]);
        let (manifest, _graph) = scan(dir.path()).unwrap();
        let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["notes.md"]);
    }

    #[test]
    fn search_skips_hidden_directories() {
        let dir = write_temp_project(&[
            ("a.md", "visible\n"),
            (".hidden/b.md", "hidden\n"),
        ]);
        let hits = search(dir.path(), "hidden", SearchOptions::default()).unwrap();
        // ".hidden/b.md" contains the substring "hidden" in its body but
        // the walker filters it out; "visible" line in a.md doesn't match.
        assert!(hits.is_empty());
    }

    // ================== resolve_project_for_file tests ==================

    #[test]
    fn resolve_finds_skrive_toml_marker() {
        let dir = write_temp_project(&[
            (".skrive.toml", "[project]\nname = \"t\"\n"),
            ("notes/a.md", "body\n"),
        ]);
        let file = dir.path().join("notes/a.md");
        let (root, rel) = resolve_project_for_file(&file).unwrap();
        assert_eq!(root.canonicalize().unwrap(), dir.path().canonicalize().unwrap());
        assert_eq!(rel, PathBuf::from("notes/a.md"));
    }

    #[test]
    fn resolve_finds_git_marker() {
        // A .git directory is enough — mirrors how editors treat any git
        // repo as a project.
        let dir = write_temp_project(&[
            (".git/HEAD", "ref: refs/heads/main\n"),
            ("a.md", "body\n"),
        ]);
        let file = dir.path().join("a.md");
        let (root, _rel) = resolve_project_for_file(&file).unwrap();
        assert_eq!(root.canonicalize().unwrap(), dir.path().canonicalize().unwrap());
    }

    #[test]
    fn resolve_falls_back_to_file_parent() {
        // No .skrive.toml or .git anywhere in the ancestry — the file's
        // immediate parent becomes the ad-hoc project root.
        let dir = write_temp_project(&[("lonely/solo.md", "body\n")]);
        let file = dir.path().join("lonely/solo.md");
        let (root, rel) = resolve_project_for_file(&file).unwrap();
        assert_eq!(
            root.canonicalize().unwrap(),
            dir.path().join("lonely").canonicalize().unwrap()
        );
        assert_eq!(rel, PathBuf::from("solo.md"));
    }

    #[test]
    fn resolve_nested_marker_is_preferred_over_ancestor() {
        // When nested markers exist, we pick the *nearest* ancestor —
        // matches the "a git repo inside a git repo" case where the
        // inner repo is what the user cares about.
        let dir = write_temp_project(&[
            (".git/HEAD", "ref: refs/heads/main\n"),
            ("inner/.skrive.toml", "[project]\nname = \"i\"\n"),
            ("inner/nested.md", "body\n"),
        ]);
        let file = dir.path().join("inner/nested.md");
        let (root, rel) = resolve_project_for_file(&file).unwrap();
        assert_eq!(
            root.canonicalize().unwrap(),
            dir.path().join("inner").canonicalize().unwrap()
        );
        assert_eq!(rel, PathBuf::from("nested.md"));
    }

    // ================== detect_history_mode tests ==================

    #[test]
    fn detect_history_mode_git_when_dot_git_directory_present() {
        let dir = write_temp_project(&[
            (".git/HEAD", "ref: refs/heads/main\n"),
            ("a.md", "body\n"),
        ]);
        assert_eq!(detect_history_mode(dir.path()), HistoryMode::Git);
    }

    #[test]
    fn detect_history_mode_git_when_dot_git_is_a_file() {
        // Worktrees and submodules use `.git` as a regular file that
        // points at the real gitdir. Still git-mode as far as Skrive's
        // history panel is concerned.
        let dir = write_temp_project(&[
            (".git", "gitdir: /some/other/path\n"),
            ("a.md", "body\n"),
        ]);
        assert_eq!(detect_history_mode(dir.path()), HistoryMode::Git);
    }

    #[test]
    fn detect_history_mode_checkpoints_when_no_git() {
        // Plain markdown folder — no .git at the root. Checkpoint mode.
        let dir = write_temp_project(&[("a.md", "body\n")]);
        assert_eq!(detect_history_mode(dir.path()), HistoryMode::Checkpoints);
    }

    #[test]
    fn detect_history_mode_checkpoints_when_dot_git_only_in_ancestor() {
        // A Skrive project opened as a subdirectory of a git repo does
        // NOT inherit git-mode — the check is "`.git/` at *this* root",
        // not "anywhere above." If the user wants the parent repo as the
        // history source, they open the parent directory as the project.
        let dir = write_temp_project(&[
            (".git/HEAD", "ref: refs/heads/main\n"),
            ("inner/a.md", "body\n"),
        ]);
        assert_eq!(
            detect_history_mode(&dir.path().join("inner")),
            HistoryMode::Checkpoints,
        );
    }

    // ================== Incremental graph update tests ==================

    fn fresh_state() -> ProjectState {
        ProjectState {
            // The `note_*` methods don't touch the filesystem — they
            // only update the in-memory graph — so any dummy path works.
            root: PathBuf::from("/tmp/skrive-test"),
            link_graph: LinkGraph::new(),
            history_mode: HistoryMode::Checkpoints,
        }
    }

    #[test]
    fn note_file_written_replaces_outgoing_edges() {
        let mut state = fresh_state();
        let rel = PathBuf::from("a.md");
        state.note_file_written(&rel, "See [b](b.md).", &Map::new());
        assert!(state
            .link_graph
            .incoming("b.md")
            .unwrap()
            .contains(&"a.md".to_string()));

        // Replace the body so the reference shifts from b.md to c.md.
        state.note_file_written(&rel, "See [c](c.md).", &Map::new());
        assert!(state.link_graph.incoming("b.md").is_none());
        assert!(state
            .link_graph
            .incoming("c.md")
            .unwrap()
            .contains(&"a.md".to_string()));
    }

    #[test]
    fn note_file_created_registers_empty_entry() {
        let mut state = fresh_state();
        state.note_file_created(Path::new("fresh.md"));
        // Registered file has an (empty) entry in forward, not None.
        assert!(state.link_graph.outgoing("fresh.md").is_some());
    }

    #[test]
    fn note_file_deleted_drops_outgoing_but_preserves_inbound() {
        let mut state = fresh_state();
        state.note_file_written(Path::new("a.md"), "See [b](b.md).", &Map::new());
        // a.md now links to b.md. Delete a.md: its outgoing edges go,
        // but the backward map entry for b.md should drop too (because
        // a.md was the only source).
        state.note_file_deleted(Path::new("a.md"));
        assert!(state.link_graph.outgoing("a.md").is_none());
        assert!(state.link_graph.incoming("b.md").is_none());
    }

    #[test]
    fn note_file_deleted_preserves_inbound_from_other_sources() {
        // When a second file also links to b.md, deleting a.md leaves
        // the backward entry for b.md in place — dead-link detection
        // still sees "c.md → b.md" after a.md goes away.
        let mut state = fresh_state();
        state.note_file_written(Path::new("a.md"), "See [b](b.md).", &Map::new());
        state.note_file_written(Path::new("c.md"), "Also [b](b.md).", &Map::new());
        state.note_file_deleted(Path::new("a.md"));
        let inbound = state.link_graph.incoming("b.md").unwrap();
        assert!(!inbound.contains("a.md"));
        assert!(inbound.contains("c.md"));
    }

    // ================== Backlinks / outgoing tests ==================

    fn state_from_temp(dir: &tempfile::TempDir) -> ProjectState {
        let (_, graph) = scan(dir.path()).expect("scan temp project");
        let root = dir.path().canonicalize().unwrap();
        let history_mode = detect_history_mode(&root);
        ProjectState {
            root,
            link_graph: graph,
            history_mode,
        }
    }

    #[test]
    fn get_backlinks_unknown_path_returns_empty() {
        let dir = write_temp_project(&[("a.md", "no links here\n")]);
        let state = state_from_temp(&dir);
        let rows = collect_backlinks(&state, "nonexistent.md").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn get_backlinks_returns_one_row_per_edge() {
        let dir = write_temp_project(&[
            (
                "index.md",
                "Opening prose.\nSee [intro](intro.md) for details.\n",
            ),
            (
                "other.md",
                "Another file.\n\nAlso see [intro](intro.md).\n",
            ),
            ("intro.md", "# Intro\n"),
        ]);
        let state = state_from_temp(&dir);
        let rows = collect_backlinks(&state, "intro.md").unwrap();

        assert_eq!(rows.len(), 2, "expected one row per source: {:?}", rows);
        // Sort ensures index.md comes before other.md.
        assert_eq!(rows[0].path, "index.md");
        assert_eq!(rows[0].line, 2); // 1-indexed, link is on the second line
        assert!(rows[0].snippet.contains("[intro](intro.md)"));
        assert_eq!(rows[1].path, "other.md");
        assert_eq!(rows[1].line, 3);
    }

    #[test]
    fn get_backlinks_reports_utf16_column_for_non_ascii_prefix() {
        // Non-ASCII in the line prefix — UTF-16 column should count
        // code units, not bytes. The "é" character is 2 bytes in UTF-8
        // but 1 UTF-16 code unit.
        let dir = write_temp_project(&[
            ("source.md", "café [intro](intro.md)\n"),
            ("intro.md", "# Intro\n"),
        ]);
        let state = state_from_temp(&dir);
        let rows = collect_backlinks(&state, "intro.md").unwrap();
        assert_eq!(rows.len(), 1);
        // `café ` = 5 UTF-16 code units ("café" is 4 — each char
        // including `é` is one UTF-16 unit — plus the space). `[intro](`
        // is 8 more units, so the URL's first char sits at UTF-16
        // column 13. Byte column would be 14 (since `é` is 2 bytes);
        // the test name tracks the point we're actually verifying.
        assert_eq!(rows[0].column, 13);
    }

    #[test]
    fn get_backlinks_snippet_truncated_with_ellipsis() {
        let long_prefix = "x".repeat(200);
        let body = format!("{} [intro](intro.md)\n", long_prefix);
        let dir = write_temp_project(&[("source.md", &body), ("intro.md", "# Intro\n")]);
        let state = state_from_temp(&dir);
        let rows = collect_backlinks(&state, "intro.md").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].snippet.ends_with('…'));
        // The cap is 160 chars; allow for the ellipsis being one char.
        assert!(rows[0].snippet.chars().count() <= 160);
    }

    #[test]
    fn get_outgoing_links_enumerates_every_edge() {
        let dir = write_temp_project(&[
            (
                "source.md",
                "See [a](a.md) and [b](b.md).\n\n[a]: a.md\n",
            ),
            ("a.md", "# A\n"),
            ("b.md", "# B\n"),
        ]);
        let state = state_from_temp(&dir);
        let links = collect_outgoing_links(&state, "source.md").unwrap();

        // Two inline uses + one reference definition = three edges. The
        // reference-style use of [a] doesn't appear because pulldown-cmark
        // resolves `[a]` as a shortcut only if `[a]:` is defined — in
        // this body `[a](a.md)` is already an explicit inline link, so
        // that's what pulldown sees.
        let targets: Vec<&str> = links.iter().map(|l| l.path.as_str()).collect();
        assert!(targets.contains(&"a.md"));
        assert!(targets.contains(&"b.md"));
    }

    #[test]
    fn get_outgoing_links_unknown_source_returns_empty() {
        let dir = write_temp_project(&[("a.md", "no links\n")]);
        let state = state_from_temp(&dir);
        let links = collect_outgoing_links(&state, "ghost.md").unwrap();
        assert!(links.is_empty());
    }

    // ================== rename_with_references tests ==================

    fn mutable_state_from_temp(dir: &tempfile::TempDir) -> ProjectState {
        let (_, graph) = scan(dir.path()).expect("scan temp project");
        let root = dir.path().canonicalize().unwrap();
        let history_mode = detect_history_mode(&root);
        ProjectState {
            root,
            link_graph: graph,
            history_mode,
        }
    }

    fn read_relative(dir: &tempfile::TempDir, rel: &str) -> String {
        std::fs::read_to_string(dir.path().join(rel)).unwrap()
    }

    #[test]
    fn rename_rewrites_inline_links_across_files() {
        let dir = write_temp_project(&[
            ("index.md", "See [intro](intro.md).\n"),
            ("other.md", "Also [intro](intro.md).\n"),
            ("intro.md", "# Intro\n"),
        ]);
        let mut state = mutable_state_from_temp(&dir);
        let report =
            rename_with_references(&mut state, "intro.md", "docs/intro.md").unwrap();

        assert_eq!(report.references_updated, 2);
        // Disk checks.
        assert!(!dir.path().join("intro.md").exists());
        assert!(dir.path().join("docs/intro.md").exists());
        assert!(read_relative(&dir, "index.md").contains("[intro](docs/intro.md)"));
        assert!(read_relative(&dir, "other.md").contains("[intro](docs/intro.md)"));
        // Files_written includes both rewritten sources (renamed file had no self-refs
        // so it's not listed here).
        assert!(report.files_written.iter().any(|p| p == "index.md"));
        assert!(report.files_written.iter().any(|p| p == "other.md"));
    }

    #[test]
    fn rename_rewrites_reference_definition() {
        let dir = write_temp_project(&[
            (
                "index.md",
                "See [introduction][intro].\n\n[intro]: intro.md\n",
            ),
            ("intro.md", "# Intro\n"),
        ]);
        let mut state = mutable_state_from_temp(&dir);
        rename_with_references(&mut state, "intro.md", "docs/intro.md").unwrap();
        let body = read_relative(&dir, "index.md");
        assert!(body.contains("[intro]: docs/intro.md"));
        // The use site text is untouched — it still says [intro], which
        // now resolves through the rewritten definition.
        assert!(body.contains("[introduction][intro]"));
    }

    #[test]
    fn rename_rewrites_wiki_links_to_new_stem() {
        let dir = write_temp_project(&[
            ("uses.md", "Refer to [[Target]] and [[target|alias]].\n"),
            ("Target.md", "# Target\n"),
        ]);
        let mut state = mutable_state_from_temp(&dir);
        rename_with_references(&mut state, "Target.md", "Archive.md").unwrap();
        let body = read_relative(&dir, "uses.md");
        assert!(body.contains("[[Archive]]"));
        assert!(body.contains("[[Archive|alias]]"));
    }

    #[test]
    fn rename_emits_relative_paths_from_subdir_sources() {
        // Source is nested; target moves across subtrees. Rewrites must
        // use `../` to step back out of the source's directory.
        let dir = write_temp_project(&[
            ("notes/post.md", "See [intro](../intro.md).\n"),
            ("intro.md", "# Intro\n"),
        ]);
        let mut state = mutable_state_from_temp(&dir);
        rename_with_references(&mut state, "intro.md", "docs/intro.md").unwrap();
        let body = read_relative(&dir, "notes/post.md");
        // notes/post.md → docs/intro.md: up one from notes, then into docs.
        assert!(
            body.contains("[intro](../docs/intro.md)"),
            "body was: {body:?}",
        );
    }

    #[test]
    fn rename_handles_self_references_in_renamed_file() {
        // The renamed file links to itself. After rename, the self-
        // reference still needs to point at the new location. `files_written`
        // should list the *new* path for this file because its content
        // did change.
        let dir = write_temp_project(&[(
            "self.md",
            "# Self\n\nSee [home](self.md).\n",
        )]);
        let mut state = mutable_state_from_temp(&dir);
        let report =
            rename_with_references(&mut state, "self.md", "renamed.md").unwrap();
        let body = read_relative(&dir, "renamed.md");
        assert!(body.contains("[home](renamed.md)"));
        assert!(report.files_written.iter().any(|p| p == "renamed.md"));
    }

    #[test]
    fn rename_refuses_when_target_exists() {
        let dir = write_temp_project(&[
            ("a.md", "# A\n"),
            ("b.md", "# B\n"),
        ]);
        let mut state = mutable_state_from_temp(&dir);
        let err = rename_with_references(&mut state, "a.md", "b.md").unwrap_err();
        assert!(matches!(err, Error::Io(_)));
        // Disk state unchanged.
        assert!(dir.path().join("a.md").exists());
        assert!(dir.path().join("b.md").exists());
    }

    #[test]
    fn rename_updates_graph_so_second_rename_works() {
        // Back-to-back renames: rename `a.md` → `b.md`, then `b.md` → `c.md`.
        // The graph has to track the intermediate key for this to work.
        let dir = write_temp_project(&[
            ("a.md", "# A\n"),
            ("other.md", "See [a](a.md).\n"),
        ]);
        let mut state = mutable_state_from_temp(&dir);
        rename_with_references(&mut state, "a.md", "b.md").unwrap();
        // After the first rename the graph should treat b.md as the target.
        let report = rename_with_references(&mut state, "b.md", "c.md").unwrap();
        assert_eq!(report.references_updated, 1);
        let body = read_relative(&dir, "other.md");
        assert!(body.contains("[a](c.md)"), "body was: {body:?}");
    }

    #[test]
    fn relative_path_helper_handles_common_cases() {
        // Root to root: filename only.
        assert_eq!(relative_path("a.md", "b.md"), "b.md");
        // Same subdir: filename only.
        assert_eq!(relative_path("notes/a.md", "notes/b.md"), "b.md");
        // Sibling subdir: up one, down one.
        assert_eq!(relative_path("notes/a.md", "docs/b.md"), "../docs/b.md");
        // Root source, subdir target: down only.
        assert_eq!(relative_path("a.md", "docs/b.md"), "docs/b.md");
        // Deep source, shallow target: multiple ups.
        assert_eq!(relative_path("x/y/z/a.md", "x/b.md"), "../../b.md");
    }

    // ================== Dead-link tests ==================

    #[test]
    fn dead_links_empty_when_everything_resolves() {
        let dir = write_temp_project(&[
            ("a.md", "See [b](b.md).\n"),
            ("b.md", "# B\n"),
        ]);
        let state = state_from_temp(&dir);
        let deads = collect_dead_links(&state).unwrap();
        assert!(deads.is_empty(), "expected no dead links, got {:?}", deads);
    }

    #[test]
    fn dead_links_flags_missing_relative_target() {
        let dir = write_temp_project(&[
            ("a.md", "See [missing](notes/gone.md).\n"),
        ]);
        let state = state_from_temp(&dir);
        let deads = collect_dead_links(&state).unwrap();
        assert_eq!(deads.len(), 1);
        assert_eq!(deads[0].source_path, "a.md");
        assert_eq!(deads[0].target, "notes/gone.md");
        assert_eq!(deads[0].line, 1);
        assert_eq!(deads[0].kind, LinkKind::Inline);
    }

    #[test]
    fn dead_links_flags_missing_reference_definition() {
        let dir = write_temp_project(&[
            (
                "a.md",
                "Intro paragraph.\n\n[gone]: other/missing.md\n",
            ),
        ]);
        let state = state_from_temp(&dir);
        let deads = collect_dead_links(&state).unwrap();
        assert_eq!(deads.len(), 1);
        assert_eq!(deads[0].kind, LinkKind::ReferenceDefinition);
        assert_eq!(deads[0].target, "other/missing.md");
    }

    #[test]
    fn dead_links_flags_wiki_target_with_no_matching_stem() {
        let dir = write_temp_project(&[
            ("a.md", "See [[Unknown Note]].\n"),
            ("b.md", "# B\n"),
        ]);
        let state = state_from_temp(&dir);
        let deads = collect_dead_links(&state).unwrap();
        assert_eq!(deads.len(), 1);
        assert_eq!(deads[0].kind, LinkKind::Wiki);
        assert_eq!(deads[0].target, "[[Unknown Note]]");
    }

    #[test]
    fn dead_links_wiki_match_is_case_insensitive() {
        // The file's stem is "Other Note"; the wiki link uses lowercase
        // "other note". CommonMark doesn't specify wiki links, but our
        // resolver matches how most wiki-link users expect things to
        // work. If we ever stop being case-insensitive here, this test
        // is the canary.
        let dir = write_temp_project(&[
            ("a.md", "See [[other note]].\n"),
            ("Other Note.md", "# hi\n"),
        ]);
        let state = state_from_temp(&dir);
        let deads = collect_dead_links(&state).unwrap();
        assert!(
            deads.is_empty(),
            "case-insensitive wiki match failed: {:?}",
            deads,
        );
    }

    // ================== preview_rename tests ==================

    #[test]
    fn preview_rename_collects_cross_file_references() {
        let dir = write_temp_project(&[
            ("index.md", "See [intro](intro.md).\n"),
            ("other.md", "Also [intro](intro.md).\n"),
            ("intro.md", "# Intro\n"),
        ]);
        let state = state_from_temp(&dir);
        let preview = preview_rename(&state, "intro.md", "docs/intro.md").unwrap();
        assert!(!preview.target_exists);
        assert_eq!(preview.references.len(), 2);
        assert!(preview.definition_updates.is_empty());
        // Each row carries kind so the UI can label the change.
        assert!(preview
            .references
            .iter()
            .all(|r| r.kind == LinkKind::Inline));
    }

    #[test]
    fn preview_rename_flags_target_exists() {
        let dir = write_temp_project(&[
            ("a.md", "See [b](b.md).\n"),
            ("b.md", "# B\n"),
        ]);
        let state = state_from_temp(&dir);
        // Renaming over a known file is a collision.
        let preview = preview_rename(&state, "b.md", "a.md").unwrap();
        assert!(preview.target_exists);
    }

    #[test]
    fn preview_rename_no_op_rename_also_flags_target_exists() {
        // User typed the same name back — not useful, not allowed.
        let dir = write_temp_project(&[("a.md", "# A\n")]);
        let state = state_from_temp(&dir);
        let preview = preview_rename(&state, "a.md", "a.md").unwrap();
        assert!(preview.target_exists);
    }

    #[test]
    fn preview_rename_partitions_self_references() {
        // Self-reference inside the file being renamed lands in
        // `definition_updates`, not `references`, so the cross-file
        // count the UI shows stays honest.
        let dir = write_temp_project(&[
            (
                "self.md",
                "# Self\n\n[home](self.md) and\nlater [[self]].\n",
            ),
            ("other.md", "See [self](self.md).\n"),
        ]);
        let state = state_from_temp(&dir);
        let preview = preview_rename(&state, "self.md", "renamed.md").unwrap();
        assert_eq!(preview.references.len(), 1);
        assert_eq!(preview.references[0].path, "other.md");
        // Self.md's two edges pointing at itself both count as self-updates.
        assert_eq!(preview.definition_updates.len(), 2);
        assert!(preview
            .definition_updates
            .iter()
            .all(|r| r.path == "self.md"));
    }

    #[test]
    fn preview_rename_picks_up_wiki_references() {
        // Wiki links resolve by filename stem, not by path. Renaming the
        // target file must surface any `[[Stem]]` reference too.
        let dir = write_temp_project(&[
            ("uses.md", "Refer to [[Target]].\n"),
            ("Target.md", "# Target\n"),
        ]);
        let state = state_from_temp(&dir);
        let preview = preview_rename(&state, "Target.md", "Archive.md").unwrap();
        assert_eq!(preview.references.len(), 1);
        assert_eq!(preview.references[0].path, "uses.md");
        assert_eq!(preview.references[0].kind, LinkKind::Wiki);
    }

    #[test]
    fn preview_rename_picks_up_reference_definition() {
        // The `[intro]: intro.md` definition line gets rewritten on
        // rename. `[introduction][intro]` use keeps referencing the
        // label, not the path, so the use site is in references too
        // (as a ReferenceUse kind, via pulldown-cmark's resolution).
        let dir = write_temp_project(&[
            (
                "index.md",
                "See [introduction][intro].\n\n[intro]: intro.md\n",
            ),
            ("intro.md", "# Intro\n"),
        ]);
        let state = state_from_temp(&dir);
        let preview = preview_rename(&state, "intro.md", "docs/intro.md").unwrap();
        // Expect exactly two rows from index.md: the use + the definition.
        let index_rows: Vec<&Reference> = preview
            .references
            .iter()
            .filter(|r| r.path == "index.md")
            .collect();
        assert_eq!(index_rows.len(), 2);
        let kinds: Vec<LinkKind> = index_rows.iter().map(|r| r.kind).collect();
        assert!(kinds.contains(&LinkKind::ReferenceUse));
        assert!(kinds.contains(&LinkKind::ReferenceDefinition));
    }

    #[test]
    fn dead_links_sorted_by_source_line_column() {
        // Two sources, multiple dead edges each — the UI wants them
        // grouped by file then top-to-bottom.
        let dir = write_temp_project(&[
            (
                "a.md",
                "See [x](missing-1.md) and\n[y](missing-2.md).\n",
            ),
            ("b.md", "Also [z](missing-3.md).\n"),
        ]);
        let state = state_from_temp(&dir);
        let deads = collect_dead_links(&state).unwrap();
        let ordered_paths: Vec<&str> =
            deads.iter().map(|d| d.source_path.as_str()).collect();
        assert_eq!(ordered_paths, vec!["a.md", "a.md", "b.md"]);
        let ordered_lines: Vec<u32> = deads.iter().map(|d| d.line).collect();
        assert_eq!(ordered_lines, vec![1, 2, 1]);
    }

    #[test]
    fn note_directory_deleted_forgets_all_files_under_it() {
        let mut state = fresh_state();
        state.note_file_written(
            Path::new("notes/inside.md"),
            "See [x](x.md).",
            &Map::new(),
        );
        state.note_file_written(
            Path::new("notes/also-inside.md"),
            "See [y](y.md).",
            &Map::new(),
        );
        state.note_file_written(
            Path::new("keepme.md"),
            "See [z](z.md).",
            &Map::new(),
        );

        state.note_directory_deleted(Path::new("notes"));

        assert!(state.link_graph.outgoing("notes/inside.md").is_none());
        assert!(state.link_graph.outgoing("notes/also-inside.md").is_none());
        // Sibling file outside the deleted dir is untouched.
        assert!(state.link_graph.outgoing("keepme.md").is_some());
    }
}
