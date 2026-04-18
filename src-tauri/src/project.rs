//! Project state and the in-memory model emitted to the frontend on open.
//!
//! The Rust core is the single source of truth for everything project-related.
//! On `open_project` we walk the directory, parse frontmatter from every
//! Markdown file, build the link graph, and hand the frontend an immutable
//! `ProjectManifest` snapshot. Subsequent updates flow through the file watcher
//! as targeted events — the frontend never re-scans.

use crate::error::{Error, Result};
use crate::frontmatter;
use crate::link_graph::{self, LinkGraph};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
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

/// State for the currently open project. Held inside a `tokio::sync::Mutex`
/// behind `tauri::State` so commands can mutate it across `await` points.
#[derive(Debug)]
pub struct ProjectState {
    pub root: PathBuf,
    /// Built during `scan` and read by Phase 3.1 (backlinks, dead links,
    /// rename-with-references). Allowed to be unread for now because the
    /// commands that consume it land in the next phase.
    #[allow(dead_code)]
    pub link_graph: LinkGraph,
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
        .filter_entry(|e| e.depth() == 0 || !is_hidden(e.file_name()))
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
        let links = link_graph::extract(&parsed, &rel);
        graph.set_links(&rel_str, links.clone());

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
            outgoing_links: links_to_strings(&links),
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
    let fm_block = frontmatter::serialize(frontmatter)?;
    let mut contents = String::with_capacity(fm_block.len() + body.len());
    contents.push_str(&fm_block);
    contents.push_str(body);
    std::fs::write(absolute, contents)?;
    Ok(())
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
        .filter_entry(|e| e.depth() == 0 || !is_hidden(e.file_name()))
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

fn links_to_strings(links: &BTreeSet<crate::link_graph::LinkTarget>) -> Vec<String> {
    links
        .iter()
        .map(|t| match t {
            crate::link_graph::LinkTarget::Relative(p) => p.clone(),
            crate::link_graph::LinkTarget::Wiki(name) => format!("[[{}]]", name),
        })
        .collect()
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
}
