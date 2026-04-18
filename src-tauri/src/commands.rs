//! Tauri commands exposed to the frontend.
//!
//! Every command goes through `AppState`, which holds the current `ProjectState`
//! and the active file watcher. Commands that touch the filesystem all flow
//! through `project::resolve_within`, which is the choke point that prevents
//! path traversal outside the project root.

use crate::error::{Error, Result};
use crate::frontmatter;
use crate::persistence::{self, AppUiState, ProjectUiState};
use crate::project::{
    self, FileContent, ProjectManifest, ProjectState, SearchHit, SearchOptions,
};
use crate::watcher;
use notify::RecommendedWatcher;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

/// Top-level state shared across all commands.
#[derive(Default)]
pub struct AppState {
    pub project: Arc<Mutex<Option<ProjectState>>>,
    pub watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    /// File-open request received from the OS before the frontend has
    /// finished booting. The frontend drains this on mount via
    /// `take_pending_open_file`; any subsequent opens are delivered as
    /// `skrive://open-file-request` events. Uses a std Mutex because
    /// the accessors never need to cross an await point.
    pub pending_open_file: Arc<StdMutex<Option<OpenFileRequest>>>,
}

/// Payload the frontend receives when the OS asks Skrive to open a file.
/// Both fields are absolute-ish as far as the frontend is concerned —
/// `project_root` is a canonical OS path suitable for passing back to
/// `open_project`; `file_path` is project-relative, forward-slash
/// separated like the rest of the manifest surface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileRequest {
    pub project_root: String,
    pub file_path: String,
}

#[tauri::command]
pub async fn open_project(
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectManifest> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(Error::Io(format!(
            "{} is not a directory",
            root.display()
        )));
    }

    let (manifest, graph) = project::scan(&root)?;
    let canonical_root = root.canonicalize()?;

    let mut project_slot = state.project.lock().await;
    *project_slot = Some(ProjectState {
        root: canonical_root,
        link_graph: graph,
    });

    // Drop any prior watcher before installing a new one.
    let mut watcher_slot = state.watcher.lock().await;
    *watcher_slot = None;

    Ok(manifest)
}

#[tauri::command]
pub async fn read_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<FileContent> {
    let project = state.project.lock().await;
    let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
    project::read(&project.root, &PathBuf::from(path))
}

#[tauri::command]
pub async fn write_file(
    path: String,
    body: String,
    frontmatter: Map<String, Value>,
    state: State<'_, AppState>,
) -> Result<()> {
    let project = state.project.lock().await;
    let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
    project::write(&project.root, &PathBuf::from(path), &body, &frontmatter)
}

#[tauri::command]
pub async fn watch_project(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    // Scoped so the project lock is released before we acquire the watcher
    // lock — never hold two locks across an await.
    let root = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        project.root.clone()
    };

    let watcher = watcher::spawn(root, app)?;
    let mut watcher_slot = state.watcher.lock().await;
    *watcher_slot = Some(watcher);
    Ok(())
}

// =========================== Extraction helpers ===========================

/// Payload returned by `try_extract_frontmatter`. Not used elsewhere in the
/// IPC surface — the command is the only producer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFrontmatter {
    pub frontmatter: Map<String, Value>,
    pub body: String,
}

/// Attempt to peel a leading YAML frontmatter block off a body string and
/// return the parsed map plus the remaining body. Returns `None` when
/// there is no fence, the fence is empty, or the YAML fails to parse —
/// the autosave driver treats `None` as "leave the body alone and write
/// it as-is". The caller guarantees we only see bodies that might have
/// a fence (simple JS-side prefix check), so the cost of invoking this
/// per save is a single IPC round-trip at most.
#[tauri::command]
pub async fn try_extract_frontmatter(
    content: String,
) -> Result<Option<ExtractedFrontmatter>> {
    let parsed = match frontmatter::parse(&content) {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    if parsed.frontmatter.is_empty() {
        return Ok(None);
    }
    Ok(Some(ExtractedFrontmatter {
        frontmatter: parsed.frontmatter,
        body: parsed.body,
    }))
}

// =========================== Creation commands ===========================

/// Create a new directory at `{parent}/{name}`. Used by the "Create new
/// project" flow. Does not canonicalize or scan — the caller is expected
/// to follow up with `open_project` on the returned path.
#[tauri::command]
pub async fn create_directory(parent: String, name: String) -> Result<String> {
    // Reject names that contain path separators, null bytes, or are empty.
    // We deliberately don't try to sanitize — if the name is invalid, the
    // user gets an error and fixes it.
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(Error::Io("directory name cannot be empty".into()));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err(Error::Io(format!(
            "directory name contains invalid characters: {}",
            trimmed
        )));
    }

    let parent_path = PathBuf::from(&parent);
    if !parent_path.is_dir() {
        return Err(Error::Io(format!("{} is not a directory", parent)));
    }

    let new_path = parent_path.join(trimmed);
    if new_path.exists() {
        return Err(Error::Io(format!(
            "{} already exists",
            new_path.display()
        )));
    }

    std::fs::create_dir(&new_path)?;
    Ok(new_path.to_string_lossy().into_owned())
}

/// Create a new empty Markdown file at the given project-relative path inside
/// the currently open project. Refuses if the file already exists.
#[tauri::command]
pub async fn create_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let root = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        project.root.clone()
    };
    project::create_new_file(&root, &PathBuf::from(&path))
}

/// Create a new subdirectory inside the currently open project at the given
/// project-relative path. Parent directories are created as needed. Distinct
/// from `create_directory` (which is the bootstrap "make a new project folder"
/// command); this one requires an open project and enforces path confinement.
#[tauri::command]
pub async fn create_subdirectory(
    path: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let root = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        project.root.clone()
    };
    project::create_new_directory(&root, &PathBuf::from(&path))
}

// =========================== Deletion commands ===========================

/// Move a project-relative file or directory to the OS trash. Works for both
/// because `trash::delete` does. Path confinement is enforced by
/// `project::resolve_existing_within`, which also refuses the project root
/// itself.
#[tauri::command]
pub async fn delete_path(
    path: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let root = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        project.root.clone()
    };
    let absolute = project::resolve_existing_within(&root, &PathBuf::from(&path))?;
    trash::delete(&absolute).map_err(|e| Error::Io(format!("failed to move to trash: {}", e)))?;
    Ok(())
}

// =========================== Search command ===========================

/// Project-wide plain-text search. Case-insensitive by default; toggled
/// per call. Returns at most `SEARCH_HIT_CAP` hits sorted by path and
/// line. Empty query returns an empty list — the frontend debounces its
/// own calls, so this is just a guardrail.
#[tauri::command]
pub async fn search_project(
    query: String,
    options: Option<SearchOptions>,
    state: State<'_, AppState>,
) -> Result<Vec<SearchHit>> {
    let root = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        project.root.clone()
    };
    let opts = options.unwrap_or_default();
    project::search(&root, &query, opts)
}

// =========================== Persistence commands ===========================

#[tauri::command]
pub async fn load_project_state(
    app: AppHandle,
    project_path: String,
) -> Result<Option<ProjectUiState>> {
    persistence::read_project_state(&app, &project_path)
}

#[tauri::command]
pub async fn save_project_state(
    app: AppHandle,
    project_path: String,
    ui_state: ProjectUiState,
) -> Result<()> {
    persistence::write_project_state(&app, &project_path, &ui_state)
}

#[tauri::command]
pub async fn load_app_state(app: AppHandle) -> Result<AppUiState> {
    persistence::read_app_state(&app)
}

#[tauri::command]
pub async fn save_app_state(
    app: AppHandle,
    ui_state: AppUiState,
) -> Result<()> {
    persistence::write_app_state(&app, &ui_state)
}

// =========================== Open-with-Skrive plumbing ===========================

/// Drained by the frontend on mount — covers the case where the OS told
/// us to open a file before the webview was ready to listen for events.
/// Returns `None` after the slot has been read; subsequent OS open-file
/// requests arrive as live `skrive://open-file-request` events.
#[tauri::command]
pub async fn take_pending_open_file(
    state: State<'_, AppState>,
) -> Result<Option<OpenFileRequest>> {
    let slot = state.pending_open_file.lock();
    match slot {
        Ok(mut s) => Ok(s.take()),
        Err(_) => Ok(None),
    }
}

/// Resolve a filesystem path into an `OpenFileRequest`, stash it in the
/// pending slot, and emit a live event so any already-booted webview
/// reacts immediately. Callers are the macOS `RunEvent::Opened` hook,
/// the single-instance plugin callback, and the initial-argv walk in
/// `setup()`. Non-existent paths and non-Markdown files are silently
/// ignored — file-association filtering is the OS's job, this helper
/// is just defensive.
pub fn queue_file_open(app: &AppHandle, path: &Path) {
    if !path.exists() || !is_markdown_path(path) {
        return;
    }
    let request = match build_open_request(path) {
        Ok(r) => r,
        Err(_) => return,
    };
    let state: State<'_, AppState> = app.state();
    if let Ok(mut slot) = state.pending_open_file.lock() {
        *slot = Some(request.clone());
    }
    let _ = app.emit("skrive://open-file-request", request);
}

fn build_open_request(path: &Path) -> Result<OpenFileRequest> {
    let (root, rel) = project::resolve_project_for_file(path)?;
    Ok(OpenFileRequest {
        project_root: root.to_string_lossy().into_owned(),
        file_path: rel.to_string_lossy().replace('\\', "/"),
    })
}

fn is_markdown_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md") | Some("markdown")
    )
}
