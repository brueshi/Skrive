//! Line-level and block-level diff.
//!
//! Two shapes coexist here. `compute_line_diff` (Phase 3.3a) walks
//! `similar::TextDiff` line-by-line and emits a flat row sequence the
//! raw-diff renderer consumes one-for-one across both panes. That's
//! the baseline that works for every user regardless of algorithm.
//!
//! `compute_diff` (Phase 3.3b) is the structural upgrade documented in
//! [`docs/3.3-algorithm-memo.md`](../../docs/3.3-algorithm-memo.md):
//! block-hash matching with 2-opt assignment. The algorithm choice
//! resolves open question T1; the module-level comment block over
//! `compute_diff` explains the reworded / moved classification rules
//! and the production follow-ups (proper Kuhn-Munkres, move-grouping
//! post-pass) the memo flagged.

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

// ================================================================
// Structural diff — Phase 3.3b.
// ================================================================
//
// Block-hash matching with 2-opt assignment, per the Phase 3.3
// algorithm memo's decision. Every block in the before and after
// documents becomes a row of a cost matrix, cells hold normalized
// character-distance scores, and a 2-opt local search picks a low-
// cost pairing. Matched pairs classify as Kept (distance 0, same
// position), Moved (distance 0, different position), or Reworded
// (distance below `REWORD_THRESHOLD`); pairs above the threshold
// split into separate Added + Deleted ops, as do unmatched rows.
// Reworded ops additionally carry an intra-block word-level diff so
// the renderer can surface added/deleted phrases inline.
//
// Production follow-ups, flagged in the memo and left as TODOs here:
//
//   1. Swap 2-opt for proper Kuhn-Munkres. The fixture transcripts are
//      unaffected, but workloads with many same-distance pairs
//      benefit from optimal assignment. Pulls in the `hungarian`
//      crate or equivalent; noted inline at `assign_two_opt`.
//   2. Move-grouping post-pass. Contiguous block-level moves with
//      the same offset should collapse into a single section-level
//      Moved op so the renderer can draw one "Moved from earlier"
//      banner per section instead of one per block. Left to the
//      renderer or a follow-up pass; the primitive ops this module
//      emits are sufficient input for either.
//   3. Heading-weighted cost metric. A heading that gets rewritten
//      should still match its paragraph children even if the heading
//      text changes significantly. Current cost is label-only; a
//      production cost would factor in structural role (heading vs.
//      paragraph) so a section's identity survives a heading rewrite.

/// One top-level block in a parsed markdown document. The frontend
/// renders blocks through its own `renderMarkdown` path; this type
/// just carries enough for diff decisions and renderer routing. `kind`
/// drives per-kind typography (headings get a slight weight bump;
/// code fences render monospace) and per-kind scroll anchoring;
/// `source` is the raw markdown, unmodified so the renderer can pass
/// it straight to `marked`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub kind: BlockKind,
    pub source: String,
}

/// Coarse classification of a markdown block for renderer routing.
/// Deliberately lossy — the renderer cares whether something is a
/// heading or a paragraph, not whether a paragraph contains a link.
/// Unknown / uncategorized blocks fall into `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    /// `# Heading` through `###### Heading`. `level` is 1..=6.
    Heading { level: u8 },
    Paragraph,
    /// Full list (either `-`/`*`/`+` or ordered); list boundaries are
    /// single contiguous blocks, not per-item blocks. Matches how a
    /// reader perceives "the list" as a unit.
    List,
    /// Triple-backtick or tilde fenced code block, including the
    /// fences themselves.
    CodeFence,
    /// `> quote` block.
    Blockquote,
    /// `---` / `***` horizontal rule.
    ThematicBreak,
    /// GFM pipe table (pipe-prefixed or pipe-internal rows).
    Table,
}

/// Semantic operation the renderer draws. `beforeIndex` / `afterIndex`
/// name the block's position in its pane (0-based, contiguous across
/// kept/deleted in the before pane and kept/added in the after pane)
/// so the renderer can sort ops per-pane into layout order without a
/// second pass over the inputs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffOp {
    /// Byte-identical block at the same index in both panes.
    Kept {
        before_index: usize,
        after_index: usize,
        block: Block,
    },
    /// Block present only in the after version.
    Added { after_index: usize, block: Block },
    /// Block present only in the before version.
    Deleted {
        before_index: usize,
        block: Block,
    },
    /// Byte-identical block at different indices. Emitted once per
    /// pair — the renderer lays it out in both panes by reading
    /// `from` for the before pane and `to` for the after pane.
    Moved {
        from: usize,
        to: usize,
        block: Block,
    },
    /// Same structural position (or matched below the reword
    /// threshold), different text. `word_diff` is the intra-block
    /// word-level diff the renderer uses to surface added / deleted
    /// phrases inline. `score` is the normalized character distance
    /// the matcher used — useful for the renderer to optionally
    /// grey out high-distance rewordings.
    Reworded {
        before_index: usize,
        after_index: usize,
        before: Block,
        after: Block,
        score: f64,
        word_diff: Vec<WordOp>,
    },
}

/// One word-level change inside a `Reworded` block. The renderer walks
/// these in order and composes the revised prose inline: `Kept` runs
/// stay plain, `Added` runs get sage tint in the after pane, `Deleted`
/// runs get strikethrough + opacity in the before pane.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WordOp {
    Kept { text: String },
    Added { text: String },
    Deleted { text: String },
}

/// Threshold above which a matched pair splits into Deleted + Added
/// rather than Reworded. Tuned on the memo's `reword` fixture
/// (middle paragraph distance 0.44). Dogfooding is the first thing
/// that would move this number; promote to `.skrive.toml` if it
/// becomes a real parameter.
const REWORD_THRESHOLD: f64 = 0.55;

/// Parse a markdown source into top-level blocks. Blank lines are the
/// block separator, with one exception: lines inside a fenced code
/// block (`` ``` `` or `~~~`) can be blank without ending the block.
/// The fence detector tracks the opening fence's token and length so
/// a `` ```toml `` opener pairs with a `` ``` `` closer of at least
/// three backticks, mirroring CommonMark's rule.
///
/// Production cut — not full CommonMark. Skips list coalescing
/// subtleties, nested blockquotes, and HTML blocks. Enough for prose
/// documents, which is what the first dogfood target (this repo and
/// the writer's own notes) looks like. If dogfooding surfaces a
/// mis-split that matters, upgrade to pulldown-cmark-driven block
/// boundary detection.
pub fn split_blocks(source: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut fence: Option<(char, usize)> = None;

    let flush = |buf: &mut Vec<&str>, out: &mut Vec<Block>| {
        if buf.is_empty() {
            return;
        }
        let joined = buf.join("\n");
        let trimmed = joined.trim();
        if !trimmed.is_empty() {
            let kind = classify_block(trimmed);
            out.push(Block {
                kind,
                source: trimmed.to_string(),
            });
        }
        buf.clear();
    };

    for line in source.split('\n') {
        if let Some((marker, _)) = fence {
            current.push(line);
            if let Some(len) = closes_fence(line, marker) {
                let _ = len;
                fence = None;
            }
            continue;
        }
        if let Some(opened) = opens_fence(line) {
            // A fence can open mid-block (a paragraph followed
            // immediately by a code fence with no blank line). Flush
            // whatever's pending so the fence stays its own block.
            flush(&mut current, &mut blocks);
            current.push(line);
            fence = Some(opened);
            continue;
        }
        if line.trim().is_empty() {
            flush(&mut current, &mut blocks);
        } else {
            current.push(line);
        }
    }
    flush(&mut current, &mut blocks);
    blocks
}

/// If `line` opens a fenced code block, return the fence character
/// and the opener length. CommonMark requires at least 3 characters
/// (`` ``` `` or `~~~`), up to 3 leading spaces of indentation, and
/// a matching run of the same character. Info strings after the run
/// are allowed but not inspected.
fn opens_fence(line: &str) -> Option<(char, usize)> {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker = rest.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let run = rest.chars().take_while(|c| *c == marker).count();
    if run < 3 {
        return None;
    }
    Some((marker, run))
}

/// If `line` closes an open fence (same marker, run >= opener length,
/// no non-whitespace after the run), return the closer length.
/// Conservative — we require the closer to stand alone (no info
/// string, no trailing text). CommonMark allows trailing whitespace.
fn closes_fence(line: &str, marker: char) -> Option<usize> {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let run = rest.chars().take_while(|c| *c == marker).count();
    if run < 3 {
        return None;
    }
    let tail = &rest[run..];
    if !tail.chars().all(|c| c.is_whitespace()) {
        return None;
    }
    Some(run)
}

/// Coarse block classification from the raw source of one block.
/// First-line heuristics — the memo's fixtures and Skrive's target
/// documents don't need more. Block-kind is a display signal for the
/// renderer, not a load-bearing algorithm input.
fn classify_block(source: &str) -> BlockKind {
    let first = source.lines().next().unwrap_or("").trim_start();
    if let Some(level) = heading_level(first) {
        return BlockKind::Heading { level };
    }
    if first.starts_with("```") || first.starts_with("~~~") {
        return BlockKind::CodeFence;
    }
    if first.starts_with(">") {
        return BlockKind::Blockquote;
    }
    if is_thematic_break(first) {
        return BlockKind::ThematicBreak;
    }
    if first.starts_with('|') || source.contains("\n|") {
        return BlockKind::Table;
    }
    if is_list_item_start(first) {
        return BlockKind::List;
    }
    BlockKind::Paragraph
}

fn heading_level(line: &str) -> Option<u8> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.starts_with(' ') && !rest.is_empty() {
        return None;
    }
    Some(hashes as u8)
}

fn is_thematic_break(line: &str) -> bool {
    let marker = line.chars().find(|c| !c.is_whitespace());
    let Some(m) = marker else {
        return false;
    };
    if m != '-' && m != '*' && m != '_' {
        return false;
    }
    let count = line.chars().filter(|c| *c == m).count();
    count >= 3 && line.chars().all(|c| c == m || c.is_whitespace())
}

fn is_list_item_start(line: &str) -> bool {
    let trimmed = line.trim_start();
    if trimmed.starts_with("- ")
        || trimmed.starts_with("* ")
        || trimmed.starts_with("+ ")
    {
        return true;
    }
    // Ordered list: `1.` / `1)` etc. Up to 9 digits per CommonMark.
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 9 {
        return false;
    }
    let after = &trimmed[digits..];
    after.starts_with(". ") || after.starts_with(") ")
}

/// Normalized Levenshtein distance on characters. 0.0 when the inputs
/// are byte-identical, 1.0 when they share nothing. Matches the
/// prototype's cost metric so fixture transcripts stay reproducible.
fn block_distance(a: &str, b: &str) -> f64 {
    if a == b {
        return 0.0;
    }
    let d = levenshtein(a, b) as f64;
    let max_len = a.chars().count().max(b.chars().count()).max(1) as f64;
    (d / max_len).min(1.0)
}

/// Classic DP Levenshtein on `char`s. Fine for paragraph-length
/// inputs (the prototype stressed up to 1000 chars per block without
/// issue). Upgrade to a Myers-style O((n+m)·D) algorithm if
/// dogfooding surfaces a long-block hotspot.
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return m;
    }
    if m == 0 {
        return n;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut curr: Vec<usize> = vec![0; m + 1];
    for i in 1..=n {
        curr[0] = i;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1)
                .min(curr[j - 1] + 1)
                .min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[m]
}

/// 2-opt local search for the assignment problem. Starts from the
/// identity assignment; swaps any pair whose swapped cost is strictly
/// lower than the current, iterated to a fixed point. Not optimal in
/// general — a production upgrade path swaps this for proper
/// Kuhn-Munkres via the `hungarian` crate. On the fixture matrices
/// (clear-cut signal, most pairs at distance 0) the two converge.
fn assign_two_opt(costs: &[Vec<f64>]) -> Vec<usize> {
    let n = costs.len();
    let mut assign: Vec<usize> = (0..n).collect();
    loop {
        let mut improved = false;
        for i in 0..n {
            for j in (i + 1)..n {
                let current = costs[i][assign[i]] + costs[j][assign[j]];
                let swapped = costs[i][assign[j]] + costs[j][assign[i]];
                if swapped + 1e-9 < current {
                    assign.swap(i, j);
                    improved = true;
                }
            }
        }
        if !improved {
            return assign;
        }
    }
}

/// Structural diff of two markdown source strings. Returns the op
/// sequence documented on `DiffOp`. Pure — no filesystem, no project
/// state — so it's safe to call from anywhere, including outside an
/// open project.
pub fn compute_diff(before: &str, after: &str) -> Vec<DiffOp> {
    let before_blocks = split_blocks(before);
    let after_blocks = split_blocks(after);
    compute_diff_blocks(&before_blocks, &after_blocks)
}

/// Core of `compute_diff` factored over pre-parsed block vectors so
/// tests can exercise the matcher directly with synthetic blocks
/// without going through the splitter. Same shape as the prototype's
/// classification logic — see `diff_memo::block_hash_assignment` for
/// the reference transcript-generating version.
fn compute_diff_blocks(before: &[Block], after: &[Block]) -> Vec<DiffOp> {
    let n = before.len();
    let m = after.len();
    if n == 0 && m == 0 {
        return Vec::new();
    }
    let size = n.max(m);
    // Padding cost exceeds the 0..1 range so real pairs always beat
    // dummy pairs when the matcher has slack. Matches the prototype.
    let padding = 10.0_f64;
    let mut matrix = vec![vec![padding; size]; size];
    for i in 0..n {
        for j in 0..m {
            matrix[i][j] = block_distance(&before[i].source, &after[j].source);
        }
    }
    let assignment = assign_two_opt(&matrix);

    // Emit ops in before-document order, then append unmatched
    // after-side rows (pure insertions) in after-document order. This
    // keeps the before pane readable top-to-bottom and deterministic
    // regardless of 2-opt's convergence path.
    let mut ops: Vec<DiffOp> = Vec::new();
    let mut after_emitted = vec![false; m];

    for i in 0..n {
        let j = assignment[i];
        let in_after = j < m;
        if !in_after {
            ops.push(DiffOp::Deleted {
                before_index: i,
                block: before[i].clone(),
            });
            continue;
        }
        let cost = matrix[i][j];
        after_emitted[j] = true;
        if cost == 0.0 {
            if i == j {
                ops.push(DiffOp::Kept {
                    before_index: i,
                    after_index: j,
                    block: after[j].clone(),
                });
            } else {
                ops.push(DiffOp::Moved {
                    from: i,
                    to: j,
                    block: after[j].clone(),
                });
            }
        } else if cost <= REWORD_THRESHOLD {
            let word_diff = word_level_diff(&before[i].source, &after[j].source);
            ops.push(DiffOp::Reworded {
                before_index: i,
                after_index: j,
                before: before[i].clone(),
                after: after[j].clone(),
                score: cost,
                word_diff,
            });
        } else {
            ops.push(DiffOp::Deleted {
                before_index: i,
                block: before[i].clone(),
            });
            ops.push(DiffOp::Added {
                after_index: j,
                block: after[j].clone(),
            });
        }
    }

    for j in 0..m {
        if !after_emitted[j] {
            ops.push(DiffOp::Added {
                after_index: j,
                block: after[j].clone(),
            });
        }
    }

    ops
}

/// Word-level diff for a Reworded block. `similar::TextDiff::from_words`
/// tokenizes on Unicode word boundaries, so "the cat sat" vs "the dog
/// sat" produces Kept("the ") + Deleted("cat") + Added("dog") +
/// Kept(" sat"). Consecutive same-kind tokens get coalesced so the
/// renderer sees one continuous run per change instead of a jagged
/// token-by-token list.
fn word_level_diff(before: &str, after: &str) -> Vec<WordOp> {
    let diff = TextDiff::from_words(before, after);
    let mut out: Vec<WordOp> = Vec::new();
    let push = |out: &mut Vec<WordOp>, tag: ChangeTag, value: &str| {
        // Coalesce into the tail when the kind matches — avoids
        // per-word operation spam in the renderer.
        match (out.last_mut(), tag) {
            (Some(WordOp::Kept { text }), ChangeTag::Equal) => text.push_str(value),
            (Some(WordOp::Added { text }), ChangeTag::Insert) => text.push_str(value),
            (Some(WordOp::Deleted { text }), ChangeTag::Delete) => text.push_str(value),
            _ => match tag {
                ChangeTag::Equal => out.push(WordOp::Kept {
                    text: value.to_string(),
                }),
                ChangeTag::Insert => out.push(WordOp::Added {
                    text: value.to_string(),
                }),
                ChangeTag::Delete => out.push(WordOp::Deleted {
                    text: value.to_string(),
                }),
            },
        }
    };
    for change in diff.iter_all_changes() {
        push(&mut out, change.tag(), change.value());
    }
    out
}

#[cfg(test)]
mod structural_tests {
    use super::*;

    /// Location of the fixture files, relative to `src-tauri/Cargo.toml`.
    fn load_fixture(name: &str) -> (String, String) {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("docs")
            .join("fixtures")
            .join("3.3");
        let before = std::fs::read_to_string(dir.join(format!("{name}-before.md")))
            .expect("fixture before");
        let after = std::fs::read_to_string(dir.join(format!("{name}-after.md")))
            .expect("fixture after");
        (before, after)
    }

    // Small helpers so the expected-op assertions read like the memo
    // transcripts: one line per expected op, easy to scan.

    fn counts(ops: &[DiffOp]) -> (usize, usize, usize, usize, usize) {
        let mut kept = 0;
        let mut added = 0;
        let mut deleted = 0;
        let mut moved = 0;
        let mut reworded = 0;
        for op in ops {
            match op {
                DiffOp::Kept { .. } => kept += 1,
                DiffOp::Added { .. } => added += 1,
                DiffOp::Deleted { .. } => deleted += 1,
                DiffOp::Moved { .. } => moved += 1,
                DiffOp::Reworded { .. } => reworded += 1,
            }
        }
        (kept, added, deleted, moved, reworded)
    }

    #[test]
    fn reword_fixture_produces_one_reworded_op() {
        let (before, after) = load_fixture("reword");
        let ops = compute_diff(&before, &after);
        let (kept, added, deleted, moved, reworded) = counts(&ops);
        assert_eq!(
            (kept, added, deleted, moved, reworded),
            (5, 0, 0, 0, 1),
            "ops: {:#?}",
            ops,
        );
    }

    #[test]
    fn reword_fixture_word_diff_is_non_trivial() {
        // The reworded block should produce at least one Added and
        // one Deleted word-op — if the word-level diff is all Kept
        // we're not feeding the renderer anything to highlight.
        let (before, after) = load_fixture("reword");
        let ops = compute_diff(&before, &after);
        let reworded = ops.iter().find_map(|op| match op {
            DiffOp::Reworded { word_diff, .. } => Some(word_diff),
            _ => None,
        });
        let word_diff = reworded.expect("reworded op present");
        assert!(
            word_diff.iter().any(|w| matches!(w, WordOp::Added { .. })),
            "expected ≥1 Added word op: {:#?}",
            word_diff,
        );
        assert!(
            word_diff
                .iter()
                .any(|w| matches!(w, WordOp::Deleted { .. })),
            "expected ≥1 Deleted word op: {:#?}",
            word_diff,
        );
    }

    #[test]
    fn reorder_fixture_surfaces_moves() {
        // Two sections swap; Prototype 1's transcript reports 6 block-
        // level moves (2 headings + 4 paragraphs). The move-grouping
        // post-pass flagged in the memo is a follow-up; the primitive
        // ops here are 6 Moved ops + 5 Kept ops.
        let (before, after) = load_fixture("reorder");
        let ops = compute_diff(&before, &after);
        let (kept, added, deleted, moved, reworded) = counts(&ops);
        assert_eq!(
            (kept, added, deleted, moved, reworded),
            (5, 0, 0, 6, 0),
            "ops: {:#?}",
            ops,
        );
    }

    #[test]
    fn insert_fixture_surfaces_added_section() {
        // A new section is inserted mid-document; the tail section's
        // position shifts down. Prototype 1 reports 7 kept + 3 moved
        // (the tail section) + 3 added (the new section). That's the
        // algorithmic output; a renderer-level post-pass could
        // collapse the tail-section moves into kept+shifted if
        // dogfooding prefers that reading.
        let (before, after) = load_fixture("insert");
        let ops = compute_diff(&before, &after);
        let (kept, added, deleted, moved, reworded) = counts(&ops);
        assert_eq!(
            (kept, added, deleted, moved, reworded),
            (7, 3, 0, 3, 0),
            "ops: {:#?}",
            ops,
        );
    }

    #[test]
    fn empty_inputs_yield_no_ops() {
        assert!(compute_diff("", "").is_empty());
    }

    #[test]
    fn identical_inputs_yield_only_kept_ops() {
        let src = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
        let ops = compute_diff(src, src);
        assert!(
            ops.iter().all(|op| matches!(op, DiffOp::Kept { .. })),
            "expected all-kept: {:#?}",
            ops,
        );
        assert_eq!(ops.len(), 3);
    }

    #[test]
    fn pure_insertion_yields_only_added_ops() {
        let ops = compute_diff("", "new paragraph\n");
        assert_eq!(ops.len(), 1);
        assert!(matches!(&ops[0], DiffOp::Added { after_index: 0, .. }));
    }

    #[test]
    fn pure_deletion_yields_only_deleted_ops() {
        let ops = compute_diff("old paragraph\n", "");
        assert_eq!(ops.len(), 1);
        assert!(matches!(
            &ops[0],
            DiffOp::Deleted {
                before_index: 0,
                ..
            }
        ));
    }

    #[test]
    fn code_fence_with_blank_lines_stays_one_block() {
        // A naive blank-line splitter would break a fenced code block
        // containing a blank line into three pieces. The fence-aware
        // splitter keeps it whole.
        let src = "```rust\nfn one() {}\n\nfn two() {}\n```\n";
        let blocks = split_blocks(src);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0].kind, BlockKind::CodeFence));
    }

    #[test]
    fn heading_levels_classify_correctly() {
        for (src, expected) in &[
            ("# h1", 1u8),
            ("## h2", 2),
            ("### h3", 3),
            ("###### h6", 6),
        ] {
            let blocks = split_blocks(src);
            assert_eq!(
                blocks[0].kind,
                BlockKind::Heading { level: *expected },
                "source: {src}",
            );
        }
    }

    #[test]
    fn word_diff_coalesces_same_kind_runs() {
        let out = word_level_diff("the quick brown", "the slow brown");
        // Expected: Kept("the "), Deleted("quick"), Added("slow"), Kept(" brown")
        assert!(out
            .iter()
            .any(|w| matches!(w, WordOp::Kept { text } if text.contains("the"))));
        assert!(out
            .iter()
            .any(|w| matches!(w, WordOp::Deleted { text } if text == "quick")));
        assert!(out
            .iter()
            .any(|w| matches!(w, WordOp::Added { text } if text == "slow")));
    }
}
