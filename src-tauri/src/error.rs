//! Error type returned by every Tauri command.
//!
//! The variants are serialized to the frontend with a `kind` discriminator and a
//! human-readable `message`, so the UI can pattern-match programmatic errors
//! (e.g. `pathOutsideProject`) without parsing strings.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum Error {
    #[error("io error: {0}")]
    Io(String),

    #[error("no project is currently open")]
    NoProjectOpen,

    #[error("path is not within the project root")]
    PathOutsideProject,

    #[error("file is not a markdown document")]
    NotMarkdown,

    #[error("frontmatter parse error: {0}")]
    Frontmatter(String),

    #[error("file watcher error: {0}")]
    Watcher(String),
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}

impl From<notify::Error> for Error {
    fn from(e: notify::Error) -> Self {
        Error::Watcher(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
