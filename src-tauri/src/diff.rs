//! Line-level diff for Phase 3.3a's raw-mode diff view.
//!
//! The structural algorithm (block-level, move-aware, reworded-aware)
//! lands in Phase 3.3b — this module ships the simpler add/delete/keep
//! renderer that the initial dogfood needs. `similar::TextDiff` is the
//! workhorse; we expose a row-oriented shape so the frontend can feed
//! both panes of `DiffView.svelte` off one walk of the diff.

use serde::Serialize;
use similar::{ChangeTag, TextDiff};

/// One row of side-by-side diff output. `Kept` rows carry the same
/// text on both sides; `Added` rows exist only on the after pane
/// (before is `None` and renders as a placeholder gap); `Deleted`
/// rows exist only on the before pane.
///
/// The `kind` discriminator and the `before` / `after` fields are
/// redundant by construction (kept ⇔ both Some; added ⇔ before None;
/// deleted ⇔ after None), but carrying the tag explicitly keeps the
/// render-side code one-pass-friendly and leaves room for 3.3b's
/// richer ops (moved, reworded) to extend the enum without breaking
/// the wire shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineDiffRow {
    pub kind: LineKind,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Kept,
    Added,
    Deleted,
}

/// Produce the side-by-side row sequence for two source strings.
/// Walks `similar`'s change list in order; each `Equal` change
/// emits a kept row, each `Delete` emits a deleted-before row, each
/// `Insert` emits an added-after row. Trailing newlines on each line
/// are stripped — the frontend renders per-line, so they'd just show
/// up as a blank tail.
pub fn compute_line_diff(before: &str, after: &str) -> Vec<LineDiffRow> {
    let diff = TextDiff::from_lines(before, after);
    let mut rows: Vec<LineDiffRow> = Vec::new();
    for change in diff.iter_all_changes() {
        let text = strip_trailing_newline(change.value());
        match change.tag() {
            ChangeTag::Equal => rows.push(LineDiffRow {
                kind: LineKind::Kept,
                before: Some(text.clone()),
                after: Some(text),
            }),
            ChangeTag::Delete => rows.push(LineDiffRow {
                kind: LineKind::Deleted,
                before: Some(text),
                after: None,
            }),
            ChangeTag::Insert => rows.push(LineDiffRow {
                kind: LineKind::Added,
                before: None,
                after: Some(text),
            }),
        }
    }
    rows
}

fn strip_trailing_newline(s: &str) -> String {
    // Order matters: check CRLF first so `"hi\r\n".strip_suffix('\n')`
    // doesn't leave a dangling `\r` that the render code would treat
    // as a visible carriage-return character.
    s.strip_suffix("\r\n")
        .or_else(|| s.strip_suffix('\n'))
        .unwrap_or(s)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_strings_produce_only_kept_rows() {
        let rows = compute_line_diff("a\nb\nc\n", "a\nb\nc\n");
        assert_eq!(rows.len(), 3);
        for row in &rows {
            assert_eq!(row.kind, LineKind::Kept);
            assert_eq!(row.before, row.after);
        }
    }

    #[test]
    fn pure_insertion_produces_added_rows_only() {
        let rows = compute_line_diff("", "x\ny\n");
        assert_eq!(rows.len(), 2);
        for row in &rows {
            assert_eq!(row.kind, LineKind::Added);
            assert!(row.before.is_none());
            assert!(row.after.is_some());
        }
    }

    #[test]
    fn pure_deletion_produces_deleted_rows_only() {
        let rows = compute_line_diff("x\ny\n", "");
        assert_eq!(rows.len(), 2);
        for row in &rows {
            assert_eq!(row.kind, LineKind::Deleted);
            assert!(row.before.is_some());
            assert!(row.after.is_none());
        }
    }

    #[test]
    fn replacement_emits_delete_then_insert() {
        // "A\nB\nC" → "A\nX\nC": similar walks the LCS and reports
        // the replaced middle line as Delete("B") + Insert("X").
        let rows = compute_line_diff("A\nB\nC\n", "A\nX\nC\n");
        let kinds: Vec<LineKind> = rows.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            vec![
                LineKind::Kept,
                LineKind::Deleted,
                LineKind::Added,
                LineKind::Kept,
            ],
            "rows: {:?}",
            rows,
        );
        let deleted = rows.iter().find(|r| r.kind == LineKind::Deleted).unwrap();
        assert_eq!(deleted.before.as_deref(), Some("B"));
        let added = rows.iter().find(|r| r.kind == LineKind::Added).unwrap();
        assert_eq!(added.after.as_deref(), Some("X"));
    }

    #[test]
    fn strip_trailing_newline_handles_lf_and_crlf() {
        assert_eq!(strip_trailing_newline("hi\n"), "hi");
        assert_eq!(strip_trailing_newline("hi\r\n"), "hi");
        assert_eq!(strip_trailing_newline("hi"), "hi");
    }

    #[test]
    fn blank_lines_round_trip_cleanly() {
        let rows = compute_line_diff("a\n\nb\n", "a\n\nb\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].before.as_deref(), Some(""));
        assert_eq!(rows[1].after.as_deref(), Some(""));
    }
}
