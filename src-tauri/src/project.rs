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
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

/// The complete snapshot returned by `open_project`. Paths are project-relative
/// and use forward slashes for consistency across platforms.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub root: String,
    pub files: Vec<FileEntry>,
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

/// Walk a directory, parse every Markdown file, and assemble the manifest plus
/// the link graph in a single pass.
pub fn scan(root: &Path) -> Result<(ProjectManifest, LinkGraph)> {
    let canonical_root = root.canonicalize()?;
    let mut files = Vec::new();
    let mut graph = LinkGraph::new();

    for entry in WalkDir::new(&canonical_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e.file_name()))
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

    Ok((
        ProjectManifest {
            root: canonical_root.to_string_lossy().into_owned(),
            files,
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

/// Write content to a file inside the project root, creating parent directories
/// as needed. The path must already be confined to the project root.
pub fn write(root: &Path, rel: &Path, content: &str) -> Result<()> {
    let absolute = resolve_within(root, rel)?;
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(absolute, content)?;
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
}
