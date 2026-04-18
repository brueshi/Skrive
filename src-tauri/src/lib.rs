//! Skrive Rust core. The Tauri builder lives here; everything else is a module
//! that can be unit-tested in isolation.

mod commands;
mod error;
mod frontmatter;
mod link_graph;
mod persistence;
mod project;
mod watcher;

use commands::{queue_file_open, AppState};
use std::path::PathBuf;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Single-instance must be registered first per the plugin's docs:
        // a second launch routes its argv into the callback below and then
        // exits, rather than spinning up a duplicate window.
        .plugin(tauri_plugin_single_instance::init(
            |app_handle, argv, _cwd| {
                for arg in argv.iter().skip(1) {
                    let path = PathBuf::from(arg);
                    queue_file_open(app_handle, &path);
                }
                // Bring the existing window forward so the user sees the
                // file they asked for without hunting for the app icon.
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::read_file,
            commands::write_file,
            commands::watch_project,
            commands::try_extract_frontmatter,
            commands::create_directory,
            commands::create_subdirectory,
            commands::create_file,
            commands::delete_path,
            commands::search_project,
            commands::load_project_state,
            commands::save_project_state,
            commands::load_app_state,
            commands::save_app_state,
            commands::take_pending_open_file,
        ])
        .setup(|app| {
            // Windows/Linux launch-with-file path: Skrive.exe notes/x.md
            // drops the file path in argv. macOS uses `RunEvent::Opened`
            // instead (handled below); argv on macOS launches is usually
            // empty so this loop is cheap and harmless there too.
            for arg in std::env::args().skip(1) {
                let path = PathBuf::from(&arg);
                queue_file_open(&app.handle(), &path);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // macOS delivers file-open requests (Finder double-click, drag-drop
        // onto the dock icon, `open -a Skrive x.md`) through this event.
        // Windows and Linux never fire it; they use the argv path above
        // for fresh launches and the single-instance callback for
        // subsequent ones.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    queue_file_open(app_handle, &path);
                }
            }
        }
        let _ = (app_handle, event);
    });
}
