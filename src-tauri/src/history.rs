//! Version history readers and writers.
//!
//! Two history sources drive the version-history panel: git for
//! `.git/`-rooted projects and Skrive-managed checkpoints for every
//! other project (see `docs/checkpoint-storage.md`). Mode is decided
//! at `open_project` in `project::detect_history_mode` and is mutually
//! exclusive per project.
//!
//! The git side exposes `list_git_commits_for_file` and
//! `read_git_blob_at`. The checkpoint side owns both writes
//! (`maybe_write_auto_checkpoint`, `create_manual_checkpoint`) and the
//! filename/slug/retention helpers. The two surfaces return IPC-shaped
//! types that the frontend unifies into a single history entry.

use crate::error::{Error, Result};
use crate::persistence;
use git2::Repository;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

impl From<git2::Error> for Error {
    fn from(e: git2::Error) -> Self {
        Error::Io(format!("git: {}", e.message()))
    }
}

/// One commit in a file's history. Fields are sized for what the
/// history panel needs to render a row plus drive the follow-up diff:
/// `short_sha` + `timestamp_ms` + `subject` render the row; `sha` names
/// the commit for the subsequent `read_git_blob_at` call; `parent_sha`
/// lets the diff view compute "this commit vs its parent" without a
/// second round-trip. `author_*` populate the hover tooltip; `body`
/// holds the non-subject portion of the commit message for the
/// expanded row state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitVersion {
    pub sha: String,
    pub short_sha: String,
    pub parent_sha: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub timestamp_ms: i64,
    pub subject: String,
    pub body: String,
}

/// Every commit that touched `relpath`, newest-first. Traversal walks
/// HEAD along parent links; each commit's tree is diffed against its
/// first parent and the commit is kept whenever the target path appears
/// on either side of any delta. The initial commit compares against an
/// empty tree — any file in that commit's tree shows up as "touched,"
/// which matches `git log -- path` semantics.
///
/// `relpath` is project-relative with forward slashes, same shape the
/// rest of the IPC surface uses. Path matching is exact — a rename that
/// changes the file's relative path starts a fresh history. Following
/// renames is a follow-up once dogfooding tells us it matters.
///
/// An unborn HEAD (brand-new repo with zero commits) returns an empty
/// list rather than an error: the history panel just shows empty until
/// the user's first commit.
pub fn list_git_commits_for_file(
    root: &Path,
    relpath: &Path,
) -> Result<Vec<GitVersion>> {
    let repo = Repository::open(root)?;
    if repo.head().is_err() {
        return Ok(Vec::new());
    }
    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;

    let target = posix_relpath(relpath);
    let mut versions: Vec<GitVersion> = Vec::new();

    for oid in revwalk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let diff =
            repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;

        let mut touched = false;
        diff.foreach(
            &mut |delta, _| {
                let old_matches = delta
                    .old_file()
                    .path()
                    .map(|p| p == target.as_path())
                    .unwrap_or(false);
                let new_matches = delta
                    .new_file()
                    .path()
                    .map(|p| p == target.as_path())
                    .unwrap_or(false);
                if old_matches || new_matches {
                    touched = true;
                }
                true
            },
            None,
            None,
            None,
        )?;

        if touched {
            versions.push(make_version(&commit));
        }
    }

    Ok(versions)
}

/// Read the file's contents at `sha`. Returns an error when the commit
/// doesn't exist, when the file isn't in that commit's tree, or when
/// the blob bytes aren't valid UTF-8. The history panel surfaces all
/// three as "can't show this version" so the distinction doesn't need
/// to propagate further.
pub fn read_git_blob_at(
    root: &Path,
    relpath: &Path,
    sha: &str,
) -> Result<String> {
    let repo = Repository::open(root)?;
    let oid = git2::Oid::from_str(sha)?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let target = posix_relpath(relpath);
    let entry = tree.get_path(&target)?;
    let blob = repo.find_blob(entry.id())?;
    let bytes = blob.content();
    std::str::from_utf8(bytes)
        .map(str::to_string)
        .map_err(|e| Error::Io(format!("git blob is not UTF-8: {e}")))
}

fn make_version(commit: &git2::Commit<'_>) -> GitVersion {
    let sha = commit.id().to_string();
    let short_sha = sha.get(..8).unwrap_or(&sha).to_string();
    let parent_sha = commit.parent_id(0).ok().map(|oid| oid.to_string());
    let author = commit.author();
    let author_name = author.name().unwrap_or("").to_string();
    let author_email = author.email().unwrap_or("").to_string();
    // git2 reports commit time in Unix seconds; the rest of the IPC
    // surface is milliseconds, so convert at the boundary.
    let timestamp_ms = commit.time().seconds() * 1000;
    let raw_message = commit.message().unwrap_or("");
    let (subject, body) = split_message(raw_message);
    GitVersion {
        sha,
        short_sha,
        parent_sha,
        author_name,
        author_email,
        timestamp_ms,
        subject,
        body,
    }
}

/// Subject is the first line; body is everything after the first blank
/// line. Matches the conventional "subject\n\nbody" commit format.
/// Messages that lack a blank-line separator have an empty body.
fn split_message(message: &str) -> (String, String) {
    let message = message.trim_start_matches('\n');
    match message.split_once("\n\n") {
        Some((first, rest)) => (
            first.lines().next().unwrap_or("").to_string(),
            rest.trim_end().to_string(),
        ),
        None => (
            message.lines().next().unwrap_or("").trim_end().to_string(),
            String::new(),
        ),
    }
}

/// Rebuild a project-relative path by splitting on the forward slash.
/// Frontend paths are posix-style; on Windows a raw `PathBuf::from` of
/// `"posts/intro.md"` becomes one component (backslash is the native
/// separator), which breaks git2's tree traversal. Splitting and
/// pushing component-by-component gives us the per-directory structure
/// both platforms need.
fn posix_relpath(relpath: &Path) -> PathBuf {
    let as_str = relpath.to_string_lossy();
    let mut out = PathBuf::new();
    for segment in as_str.split('/').filter(|s| !s.is_empty()) {
        out.push(segment);
    }
    out
}

// ============================== Checkpoints ==============================
//
// Writer side of the checkpoint-mode history source. See
// `docs/checkpoint-storage.md` for the on-disk contract this code is
// the production reference for — filename shape, dedup rule, retention,
// concurrency, and path canonicalization all follow that document.

/// Auto-checkpoint cadence. The writer skips a new auto when the most
/// recent auto for the same file is younger than this. Autosave fires
/// roughly once a second; the threshold keeps us from emitting a
/// checkpoint per edit burst without losing the granularity the
/// history panel needs across a writing session. Not currently
/// exposed in `.skrive.toml` — only `auto_cap` and `manual_cap` live
/// in the schema; make it a key under `[checkpoints]` if dogfooding
/// asks for shorter / longer windows.
const AUTO_CHECKPOINT_INTERVAL_MS: i64 = 5 * 60 * 1000;

/// Maximum byte length for a filename slug. Names longer than this get
/// truncated before the slug-building pass so the on-disk filename
/// stays well under every OS's per-component limit.
const SLUG_MAX_LEN: usize = 40;

/// Whether a checkpoint was written by the idle-trigger autosave path
/// or by an explicit user action. Encoded in the filename so the
/// reader and retention logic can tell them apart without opening the
/// file. Mirrored to the frontend as camelCase strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckpointKind {
    Auto,
    Manual,
}

impl CheckpointKind {
    fn as_filename_token(self) -> &'static str {
        match self {
            CheckpointKind::Auto => "auto",
            CheckpointKind::Manual => "manual",
        }
    }

    fn from_filename_token(token: &str) -> Option<Self> {
        match token {
            "auto" => Some(CheckpointKind::Auto),
            "manual" => Some(CheckpointKind::Manual),
            _ => None,
        }
    }
}

/// One checkpoint in a file's history. Same role as `GitVersion` on
/// the git side; the frontend unifies both via a discriminated-union
/// `HistoryEntry` in TypeScript. `id` is the opaque key used to read
/// the checkpoint back via `read_checkpoint_at` — in practice the
/// filename stem, but callers shouldn't rely on that shape. `name` is
/// populated from the sidecar for manual checkpoints when present; it
/// remains `None` for auto checkpoints and for sidecar-less manuals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointVersion {
    pub id: String,
    pub timestamp_ms: i64,
    pub kind: CheckpointKind,
    pub name: Option<String>,
    /// Hex-encoded SHA-256 of the on-disk content. Drives the writer's
    /// dedup check and lets the UI detect consecutive identical
    /// checkpoints (e.g. grey them out) if dogfooding surfaces any.
    pub content_hash: String,
}

/// Parsed metadata for one on-disk checkpoint file. Carries just
/// enough to drive dedup, retention, and the read-side panel without
/// opening the file.
#[derive(Debug, Clone)]
struct CheckpointFile {
    /// Absolute path to the checkpoint on disk.
    path: PathBuf,
    /// Filename stem (everything before `.md`). Used as the opaque
    /// public id on `CheckpointVersion` so the reader can re-locate a
    /// specific file even when timestamp + kind alone are ambiguous
    /// (e.g. manual-collision `_2` renames).
    id: String,
    timestamp_ms: i64,
    kind: CheckpointKind,
    /// Slug portion of the filename (manual only). Empty for auto
    /// checkpoints. Tests inspect it directly; production code derives
    /// the user-facing name from the sidecar instead.
    #[allow(dead_code)]
    slug: String,
}

/// Auto-checkpoint writer. Called from `write_file` after a successful
/// on-disk write; silent no-op when history mode is git. Honors the
/// 5-minute interval and content-hash dedup from the design doc:
///
/// - If the most-recent auto checkpoint for this file is newer than
///   `AUTO_CHECKPOINT_INTERVAL_MS`, skip.
/// - If the most-recent checkpoint (any kind) shares the new content
///   hash, skip.
/// - Otherwise write `{now_ms}_auto.md` and prune old autos beyond
///   `auto_cap`.
///
/// `auto_cap` comes from `.skrive.toml`'s `[checkpoints].auto_cap`
/// (default 50), threaded through from `ProjectState.config`.
///
/// All filesystem failures degrade to a logged warning rather than
/// bubbling up — an unreachable app-data dir, a full disk, or a lock
/// contention from another process shouldn't make the editor error
/// back at the user mid-save. See the "App-data directory unavailable"
/// edge case in `docs/checkpoint-storage.md`.
pub fn maybe_write_auto_checkpoint(
    app: &AppHandle,
    canonical_project_path: &Path,
    relpath: &Path,
    content: &[u8],
    auto_cap: usize,
) {
    let dir = match persistence::checkpoint_dir(app, canonical_project_path, relpath) {
        Ok(d) => d,
        Err(e) => {
            eprintln!(
                "skrive: auto-checkpoint dir unavailable for {}: {}",
                relpath.display(),
                io_message(e),
            );
            return;
        }
    };
    if let Err(e) =
        maybe_write_auto_checkpoint_at(&dir, content, current_time_ms(), auto_cap)
    {
        eprintln!(
            "skrive: auto-checkpoint write failed for {}: {}",
            relpath.display(),
            io_message(e),
        );
    }
}

/// Core of the auto-checkpoint write, factored to take the resolved
/// directory and a caller-supplied `now_ms` so tests can exercise
/// every branch without standing up a Tauri `AppHandle` or relying on
/// the real wall clock. `auto_cap` is threaded through from the
/// caller so the retention limit matches whatever `.skrive.toml`
/// dictates at write time.
fn maybe_write_auto_checkpoint_at(
    dir: &Path,
    content: &[u8],
    now_ms: i64,
    auto_cap: usize,
) -> Result<()> {
    let existing = list_checkpoint_files(dir)?;

    let last_auto = existing
        .iter()
        .filter(|c| c.kind == CheckpointKind::Auto)
        .max_by_key(|c| c.timestamp_ms);
    if let Some(last) = last_auto {
        if now_ms - last.timestamp_ms < AUTO_CHECKPOINT_INTERVAL_MS {
            return Ok(());
        }
    }

    let new_hash = hash_content(content);
    if let Some(most_recent) = existing.iter().max_by_key(|c| c.timestamp_ms) {
        let prev_hash = hash_content(&std::fs::read(&most_recent.path)?);
        if prev_hash == new_hash {
            return Ok(());
        }
    }

    let filename = format!("{now_ms:013}_{}.md", CheckpointKind::Auto.as_filename_token());
    let target = dir.join(&filename);
    std::fs::write(&target, content)?;

    prune_auto_checkpoints(dir, auto_cap);
    Ok(())
}

fn io_message(e: Error) -> String {
    match e {
        Error::Io(msg) => msg,
        other => other.to_string(),
    }
}

/// Manual-checkpoint writer. Invoked by the `create_checkpoint`
/// command. Never dedups — a user "pinning" a version is an explicit
/// act even when the content is unchanged from the prior pin. Filename
/// collisions (same timestamp + same slug, unusual but possible when
/// pinning very fast or after a clock skew) get a `_2`, `_3`, ...
/// disambiguator. After writing, prunes old manual checkpoints beyond
/// `manual_cap`; `manual_cap == 0` means unbounded (the default).
pub fn create_manual_checkpoint(
    app: &AppHandle,
    canonical_project_path: &Path,
    relpath: &Path,
    name: &str,
    content: &[u8],
    manual_cap: usize,
) -> Result<()> {
    let dir = persistence::checkpoint_dir(app, canonical_project_path, relpath)?;
    create_manual_checkpoint_at(&dir, name, content, current_time_ms(), manual_cap)
}

/// Core of the manual-checkpoint write, factored the same way as the
/// auto path so tests can drive it with a plain temp dir and a
/// caller-supplied clock.
fn create_manual_checkpoint_at(
    dir: &Path,
    name: &str,
    content: &[u8],
    now_ms: i64,
    manual_cap: usize,
) -> Result<()> {
    let slug = slugify(name);
    let mut target = dir.join(format_manual_filename(now_ms, &slug, 0));
    let mut disambiguator = 2usize;
    while target.exists() {
        target = dir.join(format_manual_filename(now_ms, &slug, disambiguator));
        disambiguator += 1;
    }
    std::fs::write(&target, content)?;
    // Persist the pre-slugify name alongside so the reader can restore
    // the user's exact typing (case, punctuation) for display.
    // Sidecar write is best-effort — a failed sidecar doesn't undo a
    // successful checkpoint, just means the reader falls back to the
    // slug-derived name.
    if let Err(e) = write_name_sidecar(&target, name) {
        eprintln!(
            "skrive: checkpoint name sidecar write failed for {}: {}",
            target.display(),
            io_message(e),
        );
    }
    prune_manual_checkpoints(dir, manual_cap);
    Ok(())
}

fn name_sidecar_path(checkpoint_path: &Path) -> PathBuf {
    checkpoint_path.with_extension("name")
}

fn write_name_sidecar(checkpoint_path: &Path, name: &str) -> Result<()> {
    std::fs::write(name_sidecar_path(checkpoint_path), name.as_bytes())?;
    Ok(())
}

fn read_name_sidecar(checkpoint_path: &Path) -> Option<String> {
    std::fs::read_to_string(name_sidecar_path(checkpoint_path)).ok()
}

fn format_manual_filename(timestamp_ms: i64, slug: &str, disambiguator: usize) -> String {
    let suffix = if disambiguator == 0 {
        String::new()
    } else {
        format!("_{disambiguator}")
    };
    format!(
        "{timestamp_ms:013}_{}_{slug}{suffix}.md",
        CheckpointKind::Manual.as_filename_token(),
    )
}

/// Turn a user-typed name into a filename slug. Lowercase, whitespace
/// runs collapse to `-`, everything non-alphanumeric-or-hyphen is
/// stripped, repeat hyphens collapse, leading/trailing hyphens trim,
/// and the result is capped at `SLUG_MAX_LEN` characters. An empty
/// result — rare, only when the name was all punctuation — falls back
/// to `"pinned"` so the filename still parses.
fn slugify(name: &str) -> String {
    let lowered: String = name
        .trim()
        .chars()
        .take(SLUG_MAX_LEN * 4)
        .flat_map(|c| c.to_lowercase())
        .collect();

    let mut out = String::with_capacity(lowered.len());
    let mut last_was_dash = false;
    for c in lowered.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_was_dash = false;
        } else if c.is_whitespace() || c == '-' || c == '_' {
            if !last_was_dash && !out.is_empty() {
                out.push('-');
                last_was_dash = true;
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.chars().count() > SLUG_MAX_LEN {
        out = out.chars().take(SLUG_MAX_LEN).collect();
        while out.ends_with('-') {
            out.pop();
        }
    }
    if out.is_empty() {
        return "pinned".into();
    }
    out
}

fn list_checkpoint_files(dir: &Path) -> Result<Vec<CheckpointFile>> {
    let mut out: Vec<CheckpointFile> = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if let Some(parsed) = parse_checkpoint_filename(name) {
            let (timestamp_ms, kind, slug) = parsed;
            let id = name.trim_end_matches(".md").to_string();
            out.push(CheckpointFile {
                path,
                id,
                timestamp_ms,
                kind,
                slug,
            });
        }
    }
    Ok(out)
}

fn parse_checkpoint_filename(name: &str) -> Option<(i64, CheckpointKind, String)> {
    let stem = name.strip_suffix(".md")?;
    let (ts_part, rest) = stem.split_once('_')?;
    if ts_part.len() != 13 || !ts_part.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let timestamp_ms: i64 = ts_part.parse().ok()?;
    let (kind_token, slug_part) = match rest.split_once('_') {
        Some((k, s)) => (k, s.to_string()),
        None => (rest, String::new()),
    };
    let kind = CheckpointKind::from_filename_token(kind_token)?;
    Some((timestamp_ms, kind, slug_part))
}

/// Keep the most recent `cap` auto checkpoints; delete the rest.
/// Best-effort — if a delete fails, we log and continue so the next
/// write still has a chance to tidy up. Manual checkpoints are never
/// touched.
fn prune_auto_checkpoints(dir: &Path, cap: usize) {
    let files = match list_checkpoint_files(dir) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut autos: Vec<CheckpointFile> = files
        .into_iter()
        .filter(|c| c.kind == CheckpointKind::Auto)
        .collect();
    if autos.len() <= cap {
        return;
    }
    autos.sort_by_key(|c| std::cmp::Reverse(c.timestamp_ms));
    for stale in autos.into_iter().skip(cap) {
        if let Err(e) = std::fs::remove_file(&stale.path) {
            eprintln!(
                "skrive: auto-checkpoint prune failed for {}: {}",
                stale.path.display(),
                e,
            );
        }
    }
}

/// Keep the most recent `cap` manual checkpoints; delete the rest,
/// along with their `.name` sidecars. `cap == 0` means unbounded —
/// the default and the historical behavior before `.skrive.toml`
/// could tune it. Best-effort like the auto prune.
fn prune_manual_checkpoints(dir: &Path, cap: usize) {
    if cap == 0 {
        return;
    }
    let files = match list_checkpoint_files(dir) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut manuals: Vec<CheckpointFile> = files
        .into_iter()
        .filter(|c| c.kind == CheckpointKind::Manual)
        .collect();
    if manuals.len() <= cap {
        return;
    }
    manuals.sort_by_key(|c| std::cmp::Reverse(c.timestamp_ms));
    for stale in manuals.into_iter().skip(cap) {
        // Sidecar delete is best-effort — a leftover `.name` file next
        // to a deleted checkpoint is harmless; the reader ignores it.
        let _ = std::fs::remove_file(name_sidecar_path(&stale.path));
        if let Err(e) = std::fs::remove_file(&stale.path) {
            eprintln!(
                "skrive: manual-checkpoint prune failed for {}: {}",
                stale.path.display(),
                e,
            );
        }
    }
}

fn hash_content(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Every checkpoint on disk for `relpath`, newest-first. Reads each
/// checkpoint's content to compute `content_hash`; the files are small
/// (markdown) and the reader only runs when the history panel opens,
/// so the per-call cost is negligible compared to the readability win
/// of a ready-to-use hash on every row.
pub fn list_checkpoints_for_file(
    app: &AppHandle,
    canonical_project_path: &Path,
    relpath: &Path,
) -> Result<Vec<CheckpointVersion>> {
    let dir = persistence::checkpoint_dir(app, canonical_project_path, relpath)?;
    list_checkpoints_in(&dir)
}

/// Core of `list_checkpoints_for_file` with the directory already
/// resolved. Factored for tests that drive the reader directly from a
/// temp dir without going through Tauri's app-data plumbing.
fn list_checkpoints_in(dir: &Path) -> Result<Vec<CheckpointVersion>> {
    let mut files = list_checkpoint_files(dir)?;
    files.sort_by_key(|c| std::cmp::Reverse(c.timestamp_ms));
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let name = if f.kind == CheckpointKind::Manual {
            read_name_sidecar(&f.path)
        } else {
            None
        };
        let bytes = std::fs::read(&f.path)?;
        let content_hash = hash_content(&bytes);
        out.push(CheckpointVersion {
            id: f.id,
            timestamp_ms: f.timestamp_ms,
            kind: f.kind,
            name,
            content_hash,
        });
    }
    Ok(out)
}

/// Read the checkpoint identified by `id` (the opaque key returned by
/// `list_checkpoints_for_file`). Errors on missing files and on ids
/// that don't match the checkpoint filename shape — the latter check
/// is what prevents a malicious or malformed id (e.g. `"../../escape"`)
/// from escaping the checkpoint directory.
pub fn read_checkpoint_at(
    app: &AppHandle,
    canonical_project_path: &Path,
    relpath: &Path,
    id: &str,
) -> Result<String> {
    if parse_checkpoint_filename(&format!("{id}.md")).is_none() {
        return Err(Error::Io(format!("invalid checkpoint id: {id}")));
    }
    let dir = persistence::checkpoint_dir(app, canonical_project_path, relpath)?;
    let target = dir.join(format!("{id}.md"));
    if !target.is_file() {
        return Err(Error::Io(format!("checkpoint {id} not found")));
    }
    let bytes = std::fs::read(&target)?;
    String::from_utf8(bytes)
        .map_err(|e| Error::Io(format!("checkpoint is not UTF-8: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Scaffold a fresh repo at `dir` configured with a fixed author.
    /// Returns the opened `Repository` so callers can drive a commit
    /// sequence without re-opening.
    fn init_repo(dir: &TempDir) -> Repository {
        let repo = Repository::init(dir.path()).expect("git init");
        let mut config = repo.config().expect("repo config");
        config.set_str("user.name", "Skrive Tester").unwrap();
        config.set_str("user.email", "tester@skrive.local").unwrap();
        repo
    }

    /// Write `content` at the project-relative `relpath`, stage it, and
    /// commit with `message`. Returns the full sha of the new commit.
    fn commit_file(
        repo: &Repository,
        dir: &TempDir,
        relpath: &str,
        content: &str,
        message: &str,
    ) -> String {
        let path = dir.path().join(relpath);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, content).unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new(relpath)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();

        let sig = Signature::now("Skrive Tester", "tester@skrive.local").unwrap();
        let parent = repo.head().ok().and_then(|h| h.target()).and_then(|oid| {
            repo.find_commit(oid).ok()
        });
        let parents: Vec<&git2::Commit> = parent.as_ref().into_iter().collect();
        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .unwrap();
        oid.to_string()
    }

    #[test]
    fn list_commits_returns_empty_on_unborn_head() {
        let dir = tempfile::tempdir().unwrap();
        let _repo = init_repo(&dir);
        let versions = list_git_commits_for_file(
            dir.path(),
            &PathBuf::from("nothing.md"),
        )
        .unwrap();
        assert!(versions.is_empty());
    }

    #[test]
    fn list_commits_returns_every_touching_commit_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(&dir);
        commit_file(&repo, &dir, "a.md", "one\n", "first");
        commit_file(&repo, &dir, "b.md", "other file\n", "unrelated");
        commit_file(&repo, &dir, "a.md", "two\n", "second on a.md");

        let versions = list_git_commits_for_file(
            dir.path(),
            &PathBuf::from("a.md"),
        )
        .unwrap();

        assert_eq!(versions.len(), 2, "b.md commit shouldn't appear: {:?}", versions);
        assert_eq!(versions[0].subject, "second on a.md");
        assert_eq!(versions[1].subject, "first");
        assert!(versions[0].parent_sha.is_some());
        // The initial commit has no parent.
        assert!(versions[1].parent_sha.is_none());
        assert_eq!(versions[0].short_sha.len(), 8);
    }

    #[test]
    fn read_blob_at_returns_contents_from_that_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(&dir);
        let first = commit_file(&repo, &dir, "a.md", "one\n", "first");
        let _second = commit_file(&repo, &dir, "a.md", "two\n", "second");

        let at_first = read_git_blob_at(
            dir.path(),
            &PathBuf::from("a.md"),
            &first,
        )
        .unwrap();
        assert_eq!(at_first, "one\n");
    }

    #[test]
    fn read_blob_at_handles_nested_paths() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(&dir);
        let sha = commit_file(
            &repo,
            &dir,
            "posts/intro.md",
            "# Intro\n",
            "add intro",
        );

        let body = read_git_blob_at(
            dir.path(),
            &PathBuf::from("posts/intro.md"),
            &sha,
        )
        .unwrap();
        assert_eq!(body, "# Intro\n");
    }

    #[test]
    fn commit_message_splits_subject_and_body() {
        let (subject, body) = split_message("first line\n\nparagraph body\n");
        assert_eq!(subject, "first line");
        assert_eq!(body, "paragraph body");

        let (subject, body) = split_message("only a subject\n");
        assert_eq!(subject, "only a subject");
        assert_eq!(body, "");
    }

    // ========== Feasibility smoke tests against the live repo ==========
    //
    // These were the Phase 3.3 Pre-flight 0a smoke tests. Now that the
    // production functions exist they route through them instead of
    // `git2` directly — same real-repo coverage, no duplication.

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    }

    #[test]
    fn live_repo_readme_history_is_non_empty() {
        let versions = list_git_commits_for_file(
            &repo_root(),
            &PathBuf::from("README.md"),
        )
        .expect("list commits");
        assert!(
            versions.len() >= 2,
            "expected README.md to have been touched by ≥2 commits in the dev repo",
        );
    }

    #[test]
    fn live_repo_readme_blob_reads_as_utf8() {
        let versions = list_git_commits_for_file(
            &repo_root(),
            &PathBuf::from("README.md"),
        )
        .expect("list commits");
        let head = versions.first().expect("at least one commit");
        let body = read_git_blob_at(
            &repo_root(),
            &PathBuf::from("README.md"),
            &head.sha,
        )
        .expect("read blob");
        assert!(!body.is_empty(), "README at HEAD should have content");
    }

    // ================== Checkpoint tests ==================

    #[test]
    fn slugify_lowercases_and_hyphenates_whitespace() {
        assert_eq!(slugify("End of Draft 1"), "end-of-draft-1");
    }

    #[test]
    fn slugify_strips_punctuation_and_collapses_hyphens() {
        assert_eq!(slugify("Hello, world!!!"), "hello-world");
        assert_eq!(slugify("  spaced   out  "), "spaced-out");
        assert_eq!(slugify("a--b__c"), "a-b-c");
    }

    #[test]
    fn slugify_falls_back_to_pinned_for_empty_result() {
        assert_eq!(slugify(""), "pinned");
        assert_eq!(slugify("!!!"), "pinned");
        assert_eq!(slugify("   "), "pinned");
    }

    #[test]
    fn slugify_truncates_at_max_len() {
        let long = "a".repeat(100);
        let slug = slugify(&long);
        assert!(slug.chars().count() <= SLUG_MAX_LEN);
    }

    #[test]
    fn parse_checkpoint_filename_round_trip_auto() {
        let name = "1712345678901_auto.md";
        let (ts, kind, slug) = parse_checkpoint_filename(name).unwrap();
        assert_eq!(ts, 1_712_345_678_901);
        assert_eq!(kind, CheckpointKind::Auto);
        assert!(slug.is_empty());
    }

    #[test]
    fn parse_checkpoint_filename_round_trip_manual() {
        let name = "1712345678901_manual_end-of-draft-1.md";
        let (ts, kind, slug) = parse_checkpoint_filename(name).unwrap();
        assert_eq!(ts, 1_712_345_678_901);
        assert_eq!(kind, CheckpointKind::Manual);
        assert_eq!(slug, "end-of-draft-1");
    }

    #[test]
    fn parse_checkpoint_filename_rejects_non_checkpoints() {
        assert!(parse_checkpoint_filename("notes.md").is_none());
        assert!(parse_checkpoint_filename("foo_auto.md").is_none());
        // Wrong kind token.
        assert!(parse_checkpoint_filename("1712345678901_weird.md").is_none());
        // Wrong timestamp width.
        assert!(parse_checkpoint_filename("123_auto.md").is_none());
    }

    #[test]
    fn auto_write_creates_first_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let now_ms = 1_000_000_000_000;
        maybe_write_auto_checkpoint_at(dir.path(), b"hello\n", now_ms, 50).unwrap();
        let files = list_checkpoint_files(dir.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].kind, CheckpointKind::Auto);
        assert_eq!(files[0].timestamp_ms, now_ms);
    }

    #[test]
    fn auto_write_skips_when_interval_has_not_elapsed() {
        let dir = tempfile::tempdir().unwrap();
        let t0 = 1_000_000_000_000;
        maybe_write_auto_checkpoint_at(dir.path(), b"one\n", t0, 50).unwrap();
        // Well under 5 minutes later, different content.
        let t1 = t0 + 60 * 1000;
        maybe_write_auto_checkpoint_at(dir.path(), b"two\n", t1, 50).unwrap();
        let files = list_checkpoint_files(dir.path()).unwrap();
        assert_eq!(files.len(), 1, "second write should be skipped: {:?}", files);
    }

    #[test]
    fn auto_write_dedups_against_most_recent_when_content_matches() {
        let dir = tempfile::tempdir().unwrap();
        let t0 = 1_000_000_000_000;
        maybe_write_auto_checkpoint_at(dir.path(), b"same\n", t0, 50).unwrap();
        // Past the 5-minute interval but content is identical — skip.
        let t1 = t0 + AUTO_CHECKPOINT_INTERVAL_MS + 1000;
        maybe_write_auto_checkpoint_at(dir.path(), b"same\n", t1, 50).unwrap();
        let files = list_checkpoint_files(dir.path()).unwrap();
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn auto_write_succeeds_past_interval_with_new_content() {
        let dir = tempfile::tempdir().unwrap();
        let t0 = 1_000_000_000_000;
        maybe_write_auto_checkpoint_at(dir.path(), b"one\n", t0, 50).unwrap();
        let t1 = t0 + AUTO_CHECKPOINT_INTERVAL_MS + 1;
        maybe_write_auto_checkpoint_at(dir.path(), b"two\n", t1, 50).unwrap();
        let files = list_checkpoint_files(dir.path()).unwrap();
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn prune_keeps_cap_newest_autos() {
        let dir = tempfile::tempdir().unwrap();
        // Drop 5 auto checkpoints with strictly-ascending timestamps.
        for i in 0..5 {
            let ts = 1_000_000_000_000 + i as i64;
            std::fs::write(
                dir.path().join(format!("{ts:013}_auto.md")),
                format!("body {i}"),
            )
            .unwrap();
        }
        prune_auto_checkpoints(dir.path(), 3);
        let remaining = list_checkpoint_files(dir.path()).unwrap();
        let timestamps: Vec<i64> = remaining.iter().map(|c| c.timestamp_ms).collect();
        assert_eq!(remaining.len(), 3);
        // The newest 3 kept.
        assert!(timestamps.contains(&1_000_000_000_002));
        assert!(timestamps.contains(&1_000_000_000_003));
        assert!(timestamps.contains(&1_000_000_000_004));
    }

    #[test]
    fn prune_ignores_manual_checkpoints() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..3 {
            let ts = 1_000_000_000_000 + i as i64;
            std::fs::write(dir.path().join(format!("{ts:013}_auto.md")), "auto").unwrap();
        }
        std::fs::write(
            dir.path().join("1500000000000_manual_milestone.md"),
            "manual",
        )
        .unwrap();
        prune_auto_checkpoints(dir.path(), 1);
        let remaining = list_checkpoint_files(dir.path()).unwrap();
        // 1 auto (the newest) + the untouched manual.
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|c| c.kind == CheckpointKind::Manual));
    }

    #[test]
    fn manual_write_renames_on_filename_collision() {
        let dir = tempfile::tempdir().unwrap();
        let now_ms = 1_000_000_000_000;
        create_manual_checkpoint_at(dir.path(), "pinned", b"one\n", now_ms, 0).unwrap();
        // Same timestamp + same slug — the manual writer appends `_2`.
        create_manual_checkpoint_at(dir.path(), "pinned", b"two\n", now_ms, 0).unwrap();
        let files = list_checkpoint_files(dir.path()).unwrap();
        assert_eq!(files.len(), 2);
        // Both manual, same slug prefix, disambiguator differs.
        for f in &files {
            assert_eq!(f.kind, CheckpointKind::Manual);
            assert!(f.slug.starts_with("pinned"));
        }
        let slugs: Vec<&str> = files.iter().map(|f| f.slug.as_str()).collect();
        assert!(slugs.contains(&"pinned"));
        assert!(slugs.iter().any(|s| s.starts_with("pinned_")));
    }

    #[test]
    fn manual_write_always_writes_even_when_content_matches() {
        // Manual checkpoints never dedup — a user pinning a version is
        // an explicit act even when content hasn't changed.
        let dir = tempfile::tempdir().unwrap();
        let t0 = 1_000_000_000_000;
        create_manual_checkpoint_at(dir.path(), "first pin", b"same\n", t0, 0).unwrap();
        let t1 = t0 + 10_000;
        create_manual_checkpoint_at(dir.path(), "second pin", b"same\n", t1, 0).unwrap();
        let files = list_checkpoint_files(dir.path()).unwrap();
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn manual_write_prunes_beyond_cap_when_set() {
        // manual_cap > 0 caps the manual-pin stack; the oldest fall
        // off the tail. Sidecars go with them.
        let dir = tempfile::tempdir().unwrap();
        let base = 1_000_000_000_000i64;
        for (i, name) in ["one", "two", "three", "four"].iter().enumerate() {
            create_manual_checkpoint_at(
                dir.path(),
                name,
                b"body\n",
                base + (i as i64) * 1000,
                2,
            )
            .unwrap();
        }
        let files = list_checkpoint_files(dir.path()).unwrap();
        assert_eq!(files.len(), 2, "cap=2 should keep only the two newest");
        // Sidecar for the oldest pins should be gone too — the reader
        // otherwise would show "name: None" for a file that doesn't
        // exist, which is harmless but wasteful.
        let leftover_sidecars: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .map(|x| x == "name")
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(leftover_sidecars.len(), 2);
    }

    #[test]
    fn manual_write_unbounded_when_cap_is_zero() {
        // `manual_cap = 0` is the default and means "never auto-prune
        // the pinned stack" — users asked for an explicit action.
        let dir = tempfile::tempdir().unwrap();
        let base = 1_000_000_000_000i64;
        for i in 0..5 {
            create_manual_checkpoint_at(
                dir.path(),
                &format!("pin-{i}"),
                b"body\n",
                base + (i as i64) * 1000,
                0,
            )
            .unwrap();
        }
        let files = list_checkpoint_files(dir.path()).unwrap();
        assert_eq!(files.len(), 5);
    }

    // ================== Reader tests ==================

    #[test]
    fn list_checkpoints_is_newest_first_with_content_hash() {
        let dir = tempfile::tempdir().unwrap();
        let t0 = 1_000_000_000_000;
        maybe_write_auto_checkpoint_at(dir.path(), b"first\n", t0, 50).unwrap();
        let t1 = t0 + AUTO_CHECKPOINT_INTERVAL_MS + 1;
        maybe_write_auto_checkpoint_at(dir.path(), b"second\n", t1, 50).unwrap();

        let versions = list_checkpoints_in(dir.path()).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].timestamp_ms, t1);
        assert_eq!(versions[1].timestamp_ms, t0);
        // Hash is derived from content, not the filename.
        assert_eq!(versions[0].content_hash, hash_content(b"second\n"));
        assert_eq!(versions[1].content_hash, hash_content(b"first\n"));
    }

    #[test]
    fn list_checkpoints_auto_has_no_name() {
        let dir = tempfile::tempdir().unwrap();
        maybe_write_auto_checkpoint_at(dir.path(), b"body\n", 1_000_000_000_000, 50).unwrap();
        let versions = list_checkpoints_in(dir.path()).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].kind, CheckpointKind::Auto);
        assert!(versions[0].name.is_none());
    }

    #[test]
    fn list_checkpoints_manual_recovers_original_name_from_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        create_manual_checkpoint_at(
            dir.path(),
            "End of Draft 1",
            b"body\n",
            1_000_000_000_000,
            0,
        )
        .unwrap();
        let versions = list_checkpoints_in(dir.path()).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].kind, CheckpointKind::Manual);
        // Sidecar preserves original case + whitespace, not the slug.
        assert_eq!(versions[0].name.as_deref(), Some("End of Draft 1"));
    }

    #[test]
    fn list_checkpoints_manual_name_is_none_when_sidecar_missing() {
        // Simulates a checkpoint written by an older build that didn't
        // persist sidecars. The reader should degrade gracefully to
        // `name: None` instead of erroring.
        let dir = tempfile::tempdir().unwrap();
        let ts = 1_000_000_000_000i64;
        std::fs::write(
            dir.path().join(format!("{ts:013}_manual_legacy.md")),
            "body\n",
        )
        .unwrap();
        let versions = list_checkpoints_in(dir.path()).unwrap();
        assert_eq!(versions.len(), 1);
        assert!(versions[0].name.is_none());
    }

    #[test]
    fn read_checkpoint_round_trips_via_id() {
        let dir = tempfile::tempdir().unwrap();
        create_manual_checkpoint_at(
            dir.path(),
            "pinned",
            b"the body\n",
            1_000_000_000_000,
            0,
        )
        .unwrap();
        let versions = list_checkpoints_in(dir.path()).unwrap();
        let target_path = dir.path().join(format!("{}.md", versions[0].id));
        let body = std::fs::read_to_string(&target_path).unwrap();
        assert_eq!(body, "the body\n");
    }

    #[test]
    fn parse_checkpoint_filename_accepts_disambiguated_manual() {
        // Collision-rename suffixes (`_2`, `_3`) need to round-trip
        // through the reader — they parse as slug="pinned_2".
        let name = "1712345678901_manual_pinned_2.md";
        let (ts, kind, slug) = parse_checkpoint_filename(name).unwrap();
        assert_eq!(ts, 1_712_345_678_901);
        assert_eq!(kind, CheckpointKind::Manual);
        assert_eq!(slug, "pinned_2");
    }
}
