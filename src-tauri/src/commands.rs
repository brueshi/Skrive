//! Tauri commands exposed to the frontend.
//!
//! Every command goes through `AppState`, which holds the current `ProjectState`
//! and the active file watcher. Commands that touch the filesystem all flow
//! through `project::resolve_within`, which is the choke point that prevents
//! path traversal outside the project root.

use crate::error::{Error, Result};
use crate::project::{self, FileContent, ProjectManifest, ProjectState};
use crate::watcher;
use notify::RecommendedWatcher;
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
    content: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let project = state.project.lock().await;
    let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
    project::write(&project.root, &PathBuf::from(path), &content)
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
