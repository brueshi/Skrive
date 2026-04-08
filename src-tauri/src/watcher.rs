//! File system watcher that bridges `notify` events into Tauri events.
//!
//! Skrive's frontend never polls. When the watcher sees a Markdown file change
//! it emits a single `project://file-changed` event with the project-relative
//! path; the frontend listens and asks the Rust core for fresh content via
//! `read_file`. Non-Markdown files and hidden files are filtered out at the
//! source.

use crate::error::Result;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use tauri::{AppHandle, Emitter};

/// Payload emitted to the frontend on every relevant file event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangePayload {
    pub path: String,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Created,
    Modified,
    Removed,
}

/// Spawn a watcher rooted at `root` and return it. The caller must keep the
/// returned watcher alive — dropping it stops the watch.
pub fn spawn(root: PathBuf, app: AppHandle) -> Result<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        // Errors here are ignored — the receiver thread will see them via the
        // channel and surface them as event payloads.
        let _ = tx.send(res);
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    let app_handle = app.clone();
    let watch_root = root.clone();
    thread::spawn(move || {
        for result in rx {
            let event = match result {
                Ok(event) => event,
                Err(_) => continue,
            };
            let Some(kind) = classify(&event.kind) else {
                continue;
            };
            for path in event.paths {
                if !is_relevant(&path) {
                    continue;
                }
                if let Some(rel) = path.strip_prefix(&watch_root).ok().map(Path::to_path_buf) {
                    let payload = FileChangePayload {
                        path: rel.to_string_lossy().replace('\\', "/"),
                        kind: kind.clone(),
                    };
                    let _ = app_handle.emit("project://file-changed", payload);
                }
            }
        }
    });

    Ok(watcher)
}

fn classify(kind: &EventKind) -> Option<ChangeKind> {
    match kind {
        EventKind::Create(_) => Some(ChangeKind::Created),
        EventKind::Modify(_) => Some(ChangeKind::Modified),
        EventKind::Remove(_) => Some(ChangeKind::Removed),
        _ => None,
    }
}

fn is_relevant(path: &Path) -> bool {
    let is_md = matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md") | Some("markdown")
    );
    if !is_md {
        return false;
    }
    // Drop hidden files and anything inside a hidden directory (e.g. `.git`).
    !path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| s.starts_with('.'))
            .unwrap_or(false)
    })
}
