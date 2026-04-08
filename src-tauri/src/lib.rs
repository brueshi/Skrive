//! Skrive Rust core. The Tauri builder lives here; everything else is a module
//! that can be unit-tested in isolation.

mod commands;
mod error;
mod frontmatter;
mod link_graph;
mod project;
mod watcher;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::read_file,
            commands::write_file,
            commands::watch_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
