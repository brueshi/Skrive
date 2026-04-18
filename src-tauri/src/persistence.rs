//! UI state persistence for Skrive.
//!
//! Implements the three-tier state model from `docs/open-questions.md` A3:
//!
//! - **`.skrive.toml`** in the project root — shared project config
//!   (lint, exports, frontmatter schema). Not this module's concern.
//! - **Platform app data, per-project** — personal state (tabs, cursor,
//!   scroll, layout mode per file, sidebar visibility/width). Stored as
//!   `{app_data_dir}/projects/{hash}.json`, where `{hash}` is the first
//!   16 hex chars of SHA-256 of the canonicalized project path.
//! - **Platform app data, global** — app-wide state (recent projects,
//!   license, first-run timestamp). Stored as `{app_data_dir}/app.json`.
//!
//! This module owns the types, path resolution, hashing, and atomic
//! JSON writes. The Tauri commands in `commands.rs` are thin wrappers.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// =========================== Per-project state ===========================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUiState {
    pub schema_version: u32,
    pub project_path: String,
    pub project_name: String,
    /// Unix milliseconds. Set by the frontend at save time.
    pub last_opened_ms: i64,
    pub sidebar: SidebarState,
    pub tabs: Vec<TabState>,
    pub active_tab_index: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarState {
    pub visible: bool,
    pub width: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub path: String,
    /// "raw" | "split" | "preview"
    pub layout_mode: String,
    pub cursor: CursorPosition,
    pub scroll_top: u32,
    pub split_divider_ratio: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorPosition {
    pub line: u32,
    pub column: u32,
}

// =========================== App-wide state ===========================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUiState {
    pub schema_version: u32,
    pub last_opened_project: Option<String>,
    pub recent_projects: Vec<RecentProject>,
    pub license: Option<String>,
    pub first_run_ms: Option<i64>,
    /// Skrive-managed personal dictionary. Words on this list get
    /// `spellcheck="false"` decorations on every occurrence in any open
    /// file, layered on top of (and additive to) the OS spellchecker's
    /// own personal dictionary. Default empty for fresh installs;
    /// `#[serde(default)]` so app.json files written before this field
    /// existed still load cleanly.
    #[serde(default)]
    pub personal_dictionary: Vec<String>,
    /// When true, the sidebar's delete flow skips the confirmation modal
    /// and goes straight to the OS trash. Flipped by the "Don't ask again"
    /// checkbox in `DeleteConfirmModal`. `#[serde(default)]` so app.json
    /// files written before this field existed still load cleanly.
    #[serde(default)]
    pub skip_delete_confirmation: bool,
    /// Flat LRU of recently opened files across all projects. The
    /// command palette filters to the currently open project and
    /// renders the top N as the empty-query default. Capped to a
    /// small cap on the write side to keep app.json bounded.
    #[serde(default)]
    pub recent_files: Vec<RecentFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    /// Canonical project root path. Matches `ProjectManifest.root`.
    pub project_path: String,
    /// Project-relative file path, forward-slash separated.
    pub file_path: String,
    pub opened_ms: i64,
}

impl Default for AppUiState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            last_opened_project: None,
            recent_projects: Vec::new(),
            license: None,
            first_run_ms: None,
            personal_dictionary: Vec::new(),
            skip_delete_confirmation: false,
            recent_files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_ms: i64,
}

// =========================== Path helpers ===========================

/// First 16 hex chars of SHA-256 of the project path. Stable across sessions,
/// collision-resistant for any reasonable number of projects per user, and
/// safe as a filename on every platform we target.
pub fn hash_project_path(project_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(project_path.as_bytes());
    let hash = hasher.finalize();
    hex::encode(&hash[..8])
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| Error::Io(format!("failed to get app data dir: {}", e)))
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app_data_dir(app)?.join("projects");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn project_state_file(app: &AppHandle, project_path: &str) -> Result<PathBuf> {
    let hash = hash_project_path(project_path);
    Ok(projects_dir(app)?.join(format!("{}.json", hash)))
}

fn app_state_file(app: &AppHandle) -> Result<PathBuf> {
    let dir = app_data_dir(app)?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("app.json"))
}

// =========================== Read / write ===========================

pub fn read_project_state(
    app: &AppHandle,
    project_path: &str,
) -> Result<Option<ProjectUiState>> {
    let file = project_state_file(app, project_path)?;
    if !file.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&file)?;
    let state: ProjectUiState = serde_json::from_str(&content)
        .map_err(|e| Error::Io(format!("failed to parse project state: {}", e)))?;
    Ok(Some(state))
}

pub fn write_project_state(
    app: &AppHandle,
    project_path: &str,
    state: &ProjectUiState,
) -> Result<()> {
    let file = project_state_file(app, project_path)?;
    let content = serde_json::to_string_pretty(state)
        .map_err(|e| Error::Io(format!("failed to serialize project state: {}", e)))?;
    atomic_write(&file, &content)
}

pub fn read_app_state(app: &AppHandle) -> Result<AppUiState> {
    let file = app_state_file(app)?;
    if !file.exists() {
        return Ok(AppUiState::default());
    }
    let content = fs::read_to_string(&file)?;
    let state: AppUiState = serde_json::from_str(&content)
        .map_err(|e| Error::Io(format!("failed to parse app state: {}", e)))?;
    Ok(state)
}

pub fn write_app_state(app: &AppHandle, state: &AppUiState) -> Result<()> {
    let file = app_state_file(app)?;
    let content = serde_json::to_string_pretty(state)
        .map_err(|e| Error::Io(format!("failed to serialize app state: {}", e)))?;
    atomic_write(&file, &content)
}

/// Write atomically: write to a `.tmp` sibling, then rename into place.
/// On Windows, rename fails if the target already exists, so we remove it
/// first — not truly atomic there, but the crash window is microscopic and
/// our state files are small enough that a partial recovery is acceptable.
fn atomic_write(path: &Path, content: &str) -> Result<()> {
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, content)?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&tmp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable() {
        let a = hash_project_path("/Users/joe/Documents/notes");
        let b = hash_project_path("/Users/joe/Documents/notes");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn hash_differs_per_path() {
        let a = hash_project_path("/Users/joe/Documents/notes");
        let b = hash_project_path("/Users/joe/Documents/journal");
        assert_ne!(a, b);
    }

    #[test]
    fn default_app_state_has_schema_version_1() {
        let state = AppUiState::default();
        assert_eq!(state.schema_version, 1);
        assert!(state.last_opened_project.is_none());
        assert!(state.recent_projects.is_empty());
    }

    #[test]
    fn project_ui_state_round_trips_through_json() {
        let state = ProjectUiState {
            schema_version: 1,
            project_path: "/tmp/example".into(),
            project_name: "example".into(),
            last_opened_ms: 1_700_000_000_000,
            sidebar: SidebarState {
                visible: true,
                width: 260,
            },
            tabs: vec![TabState {
                path: "intro.md".into(),
                layout_mode: "split".into(),
                cursor: CursorPosition { line: 10, column: 5 },
                scroll_top: 120,
                split_divider_ratio: 0.5,
            }],
            active_tab_index: 0,
        };
        let json = serde_json::to_string(&state).unwrap();
        let parsed: ProjectUiState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.project_name, "example");
        assert_eq!(parsed.tabs.len(), 1);
        assert_eq!(parsed.tabs[0].cursor.line, 10);
        // camelCase on the wire
        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"activeTabIndex\""));
    }
}
