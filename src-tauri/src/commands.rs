//! Tauri commands exposed to the frontend.
//!
//! Every command goes through `AppState`, which holds the current `ProjectState`
//! and the active file watcher. Commands that touch the filesystem all flow
//! through `project::resolve_within`, which is the choke point that prevents
//! path traversal outside the project root.

use crate::error::{Error, Result};
use crate::persistence::{self, AppUiState, ProjectUiState};
use crate::project::{self, FileContent, ProjectManifest, ProjectState};
use crate::watcher;
use notify::RecommendedWatcher;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

/// Top-level state shared across all commands.
#[derive(Default)]
pub struct AppState {
    pub project: Arc<Mutex<Option<ProjectState>>>,
    pub watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
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
