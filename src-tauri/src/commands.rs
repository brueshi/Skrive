//! Tauri commands exposed to the frontend.
//!
//! Every command goes through `AppState`, which holds the current `ProjectState`
//! and the active file watcher. Commands that touch the filesystem all flow
//! through `project::resolve_within`, which is the choke point that prevents
//! path traversal outside the project root.

use crate::error::{Error, Result};
use crate::frontmatter;
use crate::persistence::{self, AppUiState, ProjectUiState};
use crate::diff::{self, DiffOp, LineDiffRow};
use crate::history::{self, CheckpointVersion, GitVersion};
use crate::project::{
    self, Backlink, DeadLink, FileContent, HistoryMode, OutgoingLink, ProjectManifest,
    ProjectState, RenamePreview, RenameReport, SearchHit, SearchOptions,
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
    let history_mode = project::detect_history_mode(&canonical_root);
    let config = crate::config::SkriveConfig::load(&canonical_root);

    let mut project_slot = state.project.lock().await;
    *project_slot = Some(ProjectState {
        root: canonical_root,
        link_graph: graph,
        history_mode,
        config,
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
    let mut project = state.project.lock().await;
    let project = project.as_mut().ok_or(Error::NoProjectOpen)?;
    let rel = PathBuf::from(&path);
    let content = project::read(&project.root, &rel)?;
    // A fresh read is also the moment the graph's view of this file is
    // cheapest to refresh — we already have a parsed body in hand. This
    // covers the watcher-driven external-edit reload path: the frontend
    // calls read_file after receiving a `project://file-changed` event,
    // and the graph catches up without a second parse.
    project.note_file_written(&rel, &content.body, &content.frontmatter);
    Ok(content)
}

#[tauri::command]
pub async fn write_file(
    app: AppHandle,
    path: String,
    body: String,
    frontmatter: Map<String, Value>,
    state: State<'_, AppState>,
) -> Result<()> {
    let mut project = state.project.lock().await;
    let project = project.as_mut().ok_or(Error::NoProjectOpen)?;
    let rel = PathBuf::from(&path);
    project::write(&project.root, &rel, &body, &frontmatter)?;
    project.note_file_written(&rel, &body, &frontmatter);

    // In checkpoint-mode projects, the post-save tick is the auto
    // checkpoint's only trigger. The write is already durable on disk
    // by the time we get here; a checkpoint failure must not surface
    // as a save error (see docs/checkpoint-storage.md "App-data
    // directory unavailable"), so this call swallows its own errors.
    if project.history_mode == HistoryMode::Checkpoints {
        let composed = project::compose_file(&body, &frontmatter)?;
        history::maybe_write_auto_checkpoint(
            &app,
            &project.root,
            &rel,
            composed.as_bytes(),
            project.config.checkpoints.auto_cap,
        );
    }

    Ok(())
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
    let mut project = state.project.lock().await;
    let project = project.as_mut().ok_or(Error::NoProjectOpen)?;
    let rel = PathBuf::from(&path);
    project::create_new_file(&project.root, &rel)?;
    project.note_file_created(&rel);
    Ok(())
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
    let mut project = state.project.lock().await;
    let project = project.as_mut().ok_or(Error::NoProjectOpen)?;
    let rel = PathBuf::from(&path);
    let absolute = project::resolve_existing_within(&project.root, &rel)?;
    // Capture directory-ness before the trash call — after the move the
    // path is gone and the metadata call would fail.
    let is_dir = absolute.is_dir();
    trash::delete(&absolute).map_err(|e| Error::Io(format!("failed to move to trash: {}", e)))?;
    if is_dir {
        project.note_directory_deleted(&rel);
    } else {
        project.note_file_deleted(&rel);
    }
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

// =========================== Link graph commands ===========================

/// Return every link that points at `path`. Reads the source body for
/// each referencing file to produce the snippet, so a call on a busy
/// project does O(backlinks) disk reads — fine for dogfood scale, and
/// rare relative to keystrokes.
///
/// An unknown path returns `[]`, not an error. The backlinks panel
/// treats "no backlinks" and "file doesn't exist" as the same UI state,
/// so there's nothing to recover from here.
#[tauri::command]
pub async fn get_backlinks(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<Backlink>> {
    let project = state.project.lock().await;
    let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
    project::collect_backlinks(project, &path)
}

/// Return every outbound link from `path`, with position info and a
/// snippet of the source line. Consumed by Step 4's dead-link command
/// and any future "outgoing links for this file" affordance.
#[tauri::command]
pub async fn get_outgoing_links(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<OutgoingLink>> {
    let project = state.project.lock().await;
    let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
    project::collect_outgoing_links(project, &path)
}

/// Return every link in the project whose target doesn't resolve. The
/// Phase 3.4 lint engine is the primary consumer; each returned row
/// corresponds to one lint-panel entry. Empty when nothing is broken.
#[tauri::command]
pub async fn get_dead_links(
    state: State<'_, AppState>,
) -> Result<Vec<DeadLink>> {
    let project = state.project.lock().await;
    let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
    project::collect_dead_links(project)
}

/// Compute the preview payload for renaming `oldPath` to `newPath`.
/// Read-only — the modal calls this on every keystroke (debounced) so
/// the user sees which files will be rewritten before they commit.
#[tauri::command]
pub async fn preview_rename(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<RenamePreview> {
    let project = state.project.lock().await;
    let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
    project::preview_rename(project, &old_path, &new_path)
}

/// Commit a rename. Renames the file on disk, rewrites every inbound
/// reference, and returns the list of files the frontend needs to
/// refresh. See `project::rename_with_references` for the full
/// invariants.
#[tauri::command]
pub async fn rename_with_references(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<RenameReport> {
    let mut project = state.project.lock().await;
    let project = project.as_mut().ok_or(Error::NoProjectOpen)?;
    project::rename_with_references(project, &old_path, &new_path)
}

// =========================== History commands ===========================

/// Which history source is active for the currently open project. Read
/// once by the frontend after `open_project` so the history panel knows
/// whether to route its list-queries through git or through checkpoints.
/// See `project::detect_history_mode` for the decision rule.
#[tauri::command]
pub async fn get_history_mode(state: State<'_, AppState>) -> Result<HistoryMode> {
    let project = state.project.lock().await;
    let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
    Ok(project.history_mode)
}

/// Every git commit that touched `path`, newest-first. Only valid when
/// the active project is in `HistoryMode::Git`; checkpoint-mode callers
/// get an explicit error rather than a confusing "no git repo" message
/// bubbling up from `git2`. See `history::list_git_commits_for_file`
/// for the traversal rules (tree-vs-parent diff, path-exact matching).
#[tauri::command]
pub async fn get_git_history(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<GitVersion>> {
    let (root, mode) = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        (project.root.clone(), project.history_mode)
    };
    if mode != HistoryMode::Git {
        return Err(Error::Io(
            "git history is only available in git-mode projects".into(),
        ));
    }
    history::list_git_commits_for_file(&root, &PathBuf::from(&path))
}

/// Read the file's contents at a specific commit sha. Paired with the
/// output of `get_git_history` to populate one pane of the diff view.
/// Same git-mode precondition as `get_git_history`.
#[tauri::command]
pub async fn read_git_version(
    path: String,
    sha: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let (root, mode) = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        (project.root.clone(), project.history_mode)
    };
    if mode != HistoryMode::Git {
        return Err(Error::Io(
            "git blob reads are only available in git-mode projects".into(),
        ));
    }
    history::read_git_blob_at(&root, &PathBuf::from(&path), &sha)
}

/// Every checkpoint on disk for `path`, newest-first. Only valid in
/// checkpoint-mode projects; git-mode callers get an explicit error.
/// Paired with `read_checkpoint_version` the same way the git reader
/// pairs `get_git_history` with `read_git_version`.
#[tauri::command]
pub async fn get_checkpoint_history(
    app: AppHandle,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<CheckpointVersion>> {
    let (root, mode) = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        (project.root.clone(), project.history_mode)
    };
    if mode != HistoryMode::Checkpoints {
        return Err(Error::Io(
            "checkpoint history is only available in checkpoint-mode projects".into(),
        ));
    }
    history::list_checkpoints_for_file(&app, &root, &PathBuf::from(&path))
}

/// Read the checkpoint identified by `id` (the opaque key from
/// `get_checkpoint_history`). Same checkpoint-mode precondition as
/// `get_checkpoint_history`.
#[tauri::command]
pub async fn read_checkpoint_version(
    app: AppHandle,
    path: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let (root, mode) = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        (project.root.clone(), project.history_mode)
    };
    if mode != HistoryMode::Checkpoints {
        return Err(Error::Io(
            "checkpoint reads are only available in checkpoint-mode projects".into(),
        ));
    }
    history::read_checkpoint_at(&app, &root, &PathBuf::from(&path), &id)
}

/// Write a manually-named checkpoint for `path`. Invoked by the
/// history panel's "Pin version…" action. Only valid in checkpoint
/// mode; git-mode users pin by committing.
///
/// The on-disk payload is the file's current bytes read fresh from the
/// working tree (not the last write-file payload), so pinning after an
/// external edit still captures what's actually there. Empty names
/// fall back to the `"pinned"` slug — see `history::slugify`.
#[tauri::command]
pub async fn create_checkpoint(
    app: AppHandle,
    path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let (root, mode, manual_cap) = {
        let project = state.project.lock().await;
        let project = project.as_ref().ok_or(Error::NoProjectOpen)?;
        (
            project.root.clone(),
            project.history_mode,
            project.config.checkpoints.manual_cap,
        )
    };
    if mode != HistoryMode::Checkpoints {
        return Err(Error::Io(
            "checkpoints are only available in checkpoint-mode projects".into(),
        ));
    }
    let rel = PathBuf::from(&path);
    let absolute = project::resolve_existing_within(&root, &rel)?;
    let bytes = std::fs::read(&absolute)?;
    history::create_manual_checkpoint(&app, &root, &rel, &name, &bytes, manual_cap)
}

// =========================== Diff commands ===========================

/// Line-level side-by-side diff of two source strings. Computed in
/// Rust with `similar::TextDiff` so Phase 3.3b's richer structural
/// diff can extend the same module rather than diverge. Pure
/// computation — no project state touched, no filesystem access —
/// so it's safe to call from any context, including outside an
/// open project.
#[tauri::command]
pub async fn compute_line_diff(
    before: String,
    after: String,
) -> Result<Vec<LineDiffRow>> {
    Ok(diff::compute_line_diff(&before, &after))
}

/// Structural diff of two source strings. Phase 3.3b's upgrade from
/// the line-level renderer: returns a block-level op sequence
/// (Kept/Added/Deleted/Moved/Reworded) that the frontend composes
/// into the sage/slate/brass decorations documented in the UI memo.
/// Pure computation, same contract as `compute_line_diff` —
/// `DiffView.svelte` calls this alongside `compute_line_diff` in
/// structural mode; the line-level rows still drive raw-mode.
#[tauri::command]
pub async fn compute_diff(
    before: String,
    after: String,
) -> Result<Vec<DiffOp>> {
    Ok(diff::compute_diff(&before, &after))
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
