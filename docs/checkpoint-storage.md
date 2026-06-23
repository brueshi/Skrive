> **PARTIALLY STALE (2026-06-22).** The on-disk format (path layout, hashing, dedup, retention) describes the Electron checkpoint store, which still exists but is a frozen stand-in — checkpoints were NOT ported to the Zig shell, and version history is being rebuilt natively (`planning/native-version-history-plan.md`). The API vocabulary (Tauri commands, Rust `pub fn` signatures, "Tauri app-data dir") is dead-stack. Treat the data layout as a record, not a target.

# Checkpoint Storage Design

The on-disk shape of Skrive's checkpoint system — the lightweight version history for projects that aren't git repos. Companion to [`3.3-diff-ui-design.md`](3.3-diff-ui-design.md) (reads checkpoints) and [`../planning/phase-3.3-plan.md`](../planning/phase-3.3-plan.md) §1.3–1.4 (writes and lists them).

Git-mode projects (anything with a `.git/` ancestor) never write checkpoints. The two sources are mutually exclusive per project — see [open question A4 resolution](../planning/open-questions.md#a4-whats-the-schema-for-skrivetoml) and the plan's mode-detection rule. Everything below applies to checkpoint-mode projects only.

## Where checkpoints live

```
{app_data_dir}/projects/{project_hash}/checkpoints/{file_hash}/{timestamp}_{kind}{name_suffix}.md
```

- `{app_data_dir}` — Tauri's platform-appropriate app data directory. Same root that already holds `app.json` and `projects/{project_hash}.json` for UI state. Skrive never touches the project directory itself for checkpoint storage.
- `{project_hash}` — SHA-256 of the canonicalized absolute project path, truncated to the first 16 hex characters. Same hashing the existing project-state persistence already uses, so a project's checkpoint directory sits next to its UI state file. If the user moves the project, the hash changes and the old checkpoint dir is orphaned — consistent with how project UI state orphans today.
- `{file_hash}` — SHA-256 of the project-relative file path in forward-slash form, truncated to 16 hex characters. Not the file's content hash. Two files with identical content but different paths keep separate checkpoint histories.
- `{timestamp}` — Unix milliseconds, fixed width 13 digits. Lexicographically sortable.
- `{kind}` — literal `auto` or `manual`. Two-character prefix plus underscore would also work but the full word is readable when glancing at the directory in Finder.
- `{name_suffix}` — for manual checkpoints, `_{slug}` where slug is the user-typed name lowercased, spaces replaced with `-`, non-alphanumerics stripped, truncated to 40 characters. Empty for auto checkpoints.

Example for a manual checkpoint titled "End of draft 1" on `posts/intro.md` in a project hashed to `a3f2b1c4d5e6f789`:

```
{app_data_dir}/projects/a3f2b1c4d5e6f789/checkpoints/7d8e9f0a1b2c3d4e/1712345678901_manual_end-of-draft-1.md
```

The filename is self-describing on disk — a user poking around can tell what's what without opening the files. That's the one weak argument for human-readable names over opaque hashes; we accept the tiny extra width to preserve it.

## File format

Each checkpoint file is the verbatim on-disk bytes of the source file at the checkpoint moment. Raw source, including any frontmatter. No wrapper, no metadata, no transformation. A checkpoint can be opened in any text editor and reads as the original file.

Rationale: checkpoints are used by the diff view, which already knows how to parse markdown + frontmatter for display. Adding a wrapper format would require custom parsing and would fight with users who might want to restore a checkpoint manually by copying its content back into the project.

Metadata that isn't in the content (timestamp, kind, name) is in the filename.

## When checkpoints get written

**Automatic (idle trigger).** On every `write_file` (which fires from autosave's 1-second debounce), check the timestamp of the most recent auto checkpoint for this file. If ≥ 5 minutes have elapsed, write a new auto checkpoint. The threshold is deliberately coarse — we don't want one checkpoint per edit burst.

**Manual.** A `create_checkpoint(path, name)` Tauri command invoked from the history panel's "Pin version…" menu item. Always writes, never deduplicates. If the name collides with an existing manual checkpoint's slug, append a disambiguator (`_2`, `_3`).

**Dedup rule.** Before writing either kind, compute a SHA-256 of the new content and compare to the most recent checkpoint's content hash (auto or manual, whichever is latest for this file). If identical, skip. No point storing two identical snapshots.

**What counts as a write.** Every successful `write_file` Tauri command. External edits the watcher picks up route through `read_file`, which doesn't write checkpoints — external edits are something Skrive didn't cause, so Skrive doesn't checkpoint them. If we decide later that external edits should also create checkpoints, that's an additive change.

## Retention policy

Two independent caps per file:

- **`auto_cap`** — the maximum number of auto checkpoints kept. Default `50`. Pruned oldest-first after each new auto write. At a 5-minute interval, 50 auto checkpoints cover about four hours of active editing — long enough to step back through a writing session, short enough to keep the per-file footprint bounded.
- **`manual_cap`** — the maximum number of manual checkpoints kept. Default *unbounded*. Users who manually checkpoint are deliberately marking milestones; pruning those behind their back would be surprise behavior.

Both caps are `.skrive.toml` keys under `[checkpoints]`, parsed on `open_project`. The defaults above apply when the file (or section) is absent. Reopen the project to pick up edits to `.skrive.toml` (live reload via the watcher is tracked as a follow-up).

**Pruning is best-effort.** A write that succeeds but a prune that fails logs a warning; the next write retries. Losing one stale checkpoint is worse than losing a new one because a delete failed.

## Read API

The production history reader in [`phase-3.3-plan.md` §1.4](../planning/phase-3.3-plan.md#14-checkpoint-reader) exposes:

```rust
pub fn list_checkpoints_for_file(root: &Path, relpath: &Path) -> Result<Vec<CheckpointVersion>>
pub fn read_checkpoint_at(root: &Path, relpath: &Path, timestamp_ms: i64) -> Result<String>
```

`CheckpointVersion`:

```rust
pub struct CheckpointVersion {
    pub timestamp_ms: i64,
    pub kind: CheckpointKind,  // Auto | Manual
    pub name: Option<String>,  // manual name (not slug) when Manual
    pub content_hash: String,  // hex-encoded SHA-256 of content, for dedup and UI badges
}
```

The list is sorted by `timestamp_ms` descending (newest first), matching the history panel's display order. `content_hash` feeds the dedup check and lets the UI gray out consecutive identical-content entries if dogfooding shows duplicates are ever visible.

## Path canonicalization

The project path used for `{project_hash}` is the canonicalized absolute path — same function `persistence::project_path_hash` already uses. Two editor sessions opening the same project via different aliases (symlinks, different case on case-insensitive filesystems) resolve to the same hash and share checkpoint history.

The file-relative path used for `{file_hash}` is the project-relative path with forward-slash separators. Backslashes on Windows normalize to forward slashes before hashing. Renames that change the relative path mean the old checkpoint dir is orphaned — Phase 3.1's rename-with-references would need an extension to migrate checkpoint history on rename. That's out of scope for 3.3a; noted as a follow-up.

## Edge cases to flag

- **Concurrent writes.** Two tabs of the same file, autosave firing in parallel. The file-write lock exists at the OS level but checkpoint writes are additive — worst case we write two auto checkpoints at the same timestamp. Resolution: if a filename collision occurs during write, append `_N` where N increments until the name is free. Rare enough to not worry about further.
- **Filesystem case sensitivity.** Different OSes disagree about whether `A.md` and `a.md` are the same file. Our hash uses the exact bytes of the project-relative path, so case-divergent paths keep separate histories. If this proves wrong in dogfooding, we case-fold the path before hashing — but that's a behavior change, not a bug fix.
- **Large files.** No cap on file size. A 10 MB markdown file gets a full-content copy per checkpoint; at `auto_cap = 50` that's 500 MB per file. Pathological but possible. If dogfooding surfaces a user who hits this, add a `max_file_size_kb` option to skip auto checkpoints above a threshold. Manual checkpoints always write regardless of size.
- **Non-UTF-8 content.** Skrive operates on markdown, which we assume is UTF-8. Checkpoints preserve the raw bytes; if the source file isn't UTF-8, the checkpoint isn't either. The diff view's UTF-8 decoding would fail on read — the right behavior is to surface the error as "this file isn't valid UTF-8", same as how Skrive handles it today in the editor.
- **App-data directory unavailable.** If Tauri can't resolve app data (edge cases on locked-down systems), checkpoint writes fail silently after logging a warning. The app stays usable; version history is just unavailable for the session.

## What this commits us to

- Checkpoint dir lives outside the project — no `.gitignore` surgery, no accidental commits.
- Filenames carry enough metadata to be self-describing on disk.
- Raw source bytes, no wrapper format.
- Auto writes on idle (5-minute threshold), manual writes on command.
- Dedup against the most recent checkpoint's content hash.
- Two independent caps: `auto_cap = 50` default, `manual_cap = 0` (unbounded) default. Tunable via `.skrive.toml`'s `[checkpoints]` section.
- Retention pruning is best-effort; failures don't block writes.

Implementation in 3.3a inherits this. Deviation without amending this doc is a bug.
