//! Phase 3.3 memo — algorithm prototypes.
//!
//! Throwaway. These modules implement each candidate algorithm against
//! the fixture pairs under `docs/fixtures/3.3/` so the memo has
//! concrete output to compare. Delete this whole file once the chosen
//! algorithm graduates into production code.
//!
//! Run with:
//!
//! ```sh
//! cargo test --manifest-path src-tauri/Cargo.toml diff_memo -- --nocapture
//! ```
//!
//! Every prototype emits a transcript of "operations" (kept / reworded /
//! moved / added / deleted) per fixture. The memo eyeballs those
//! transcripts against the expected output documented in the fixture
//! descriptions.

#![cfg(test)]

use std::path::PathBuf;

/// Location of the fixture files, relative to `native/diff/Cargo.toml`.
fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("docs")
        .join("fixtures")
        .join("3.3")
}

fn load_fixture(name: &str) -> (String, String) {
    let dir = fixtures_dir();
    let before = std::fs::read_to_string(dir.join(format!("{name}-before.md")))
        .expect("fixture before");
    let after = std::fs::read_to_string(dir.join(format!("{name}-after.md")))
        .expect("fixture after");
    (before, after)
}

/// Split a markdown document into top-level blocks. For the memo
/// fixtures this is a paragraph / heading / list split — we don't need
/// full AST awareness to evaluate algorithm output quality. Blank lines
/// are the block separator.
fn split_blocks(source: &str) -> Vec<String> {
    source
        .split("\n\n")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Normalized Levenshtein distance between two block strings. Returns
/// 0.0 when the blocks are byte-identical, 1.0 when they share nothing.
fn block_distance(a: &str, b: &str) -> f64 {
    if a == b {
        return 0.0;
    }
    let d = levenshtein(a, b) as f64;
    let max_len = a.chars().count().max(b.chars().count()).max(1) as f64;
    (d / max_len).min(1.0)
}

/// Classic DP Levenshtein on characters. Fine for paragraph-length
/// inputs; the fixtures are all under 1000 chars per block.
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

/// Truncate a block to a one-line summary for transcript output. Pulls
/// the first logical line; anything past ~60 chars ellipsizes. Nothing
/// semantic; this is purely for readable transcripts.
fn summarize(block: &str) -> String {
    let first_line = block.lines().next().unwrap_or("").trim();
    let max = 64usize;
    if first_line.chars().count() > max {
        let truncated: String = first_line.chars().take(max - 3).collect();
        format!("{truncated}...")
    } else {
        first_line.to_string()
    }
}

#[derive(Debug, Clone)]
enum Op {
    Kept {
        index: usize,
        text: String,
    },
    Reworded {
        index: usize,
        score: f64,
        text: String,
    },
    Moved {
        from: usize,
        to: usize,
        text: String,
    },
    MovedAndReworded {
        from: usize,
        to: usize,
        score: f64,
        text: String,
    },
    Added {
        index: usize,
        text: String,
    },
    Deleted {
        index: usize,
        text: String,
    },
}

fn render_ops(ops: &[Op]) -> String {
    let mut out = String::new();
    for op in ops {
        match op {
            Op::Kept { index, text } => {
                out.push_str(&format!("  [{index}] kept       {text}\n"));
            }
            Op::Reworded { index, score, text } => {
                out.push_str(&format!(
                    "  [{index}] reworded   (d={score:.2}) {text}\n"
                ));
            }
            Op::Moved { from, to, text } => {
                out.push_str(&format!(
                    "  [{from}→{to}] moved      {text}\n"
                ));
            }
            Op::MovedAndReworded {
                from,
                to,
                score,
                text,
            } => {
                out.push_str(&format!(
                    "  [{from}→{to}] moved+rew  (d={score:.2}) {text}\n"
                ));
            }
            Op::Added { index, text } => {
                out.push_str(&format!("  [{index}] +added     {text}\n"));
            }
            Op::Deleted { index, text } => {
                out.push_str(&format!("  [{index}] -deleted   {text}\n"));
            }
        }
    }
    out
}

// ================================================================
// Prototype 1 — block-hash + assignment (Hungarian stand-in).
//
// Parses both documents into block lists, hashes each block, computes
// a Levenshtein-based cost matrix, solves the assignment problem via
// 2-opt local search, and classifies each pair as kept / reworded /
// moved / moved+reworded. Unassigned rows become deletes; unassigned
// cols become adds.
//
// The matcher is 2-opt local search rather than proper Hungarian /
// Kuhn-Munkres. That's a prototype-scope simplification: on the fixture
// matrices (small, clear signal, most pairs at distance 0) the two
// converge to the same assignment. A production implementation of this
// algorithm would use real Hungarian assignment — noted in the memo so
// we don't confuse the matcher quality with the algorithmic approach.
// ================================================================

/// Threshold above which a matched pair is considered two distinct
/// blocks (delete + add) rather than a reworded one. Tuned by eye on
/// the fixtures; the memo's observations section interrogates whether
/// this threshold holds.
const REWORD_THRESHOLD: f64 = 0.55;

/// Solve the assignment problem for a square cost matrix via 2-opt
/// local search. Starts from the identity assignment; swaps any pair
/// whose swapped cost is strictly lower than the current, iterated to
/// a fixed point. Polynomial time, not optimal in general, but
/// optimal-ish on the fixture matrices. See module header.
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

fn block_hash_assignment(before: &[String], after: &[String]) -> Vec<Op> {
    let n = before.len();
    let m = after.len();
    let size = n.max(m);
    // Padding cost exceeds the 0..1 range so real pairs always beat
    // dummy pairs when possible.
    let padding = 10.0_f64;
    let mut matrix = vec![vec![padding; size]; size];
    for i in 0..n {
        for j in 0..m {
            matrix[i][j] = block_distance(&before[i], &after[j]);
        }
    }

    let assignment = assign_two_opt(&matrix);

    let mut ops: Vec<Op> = Vec::new();
    for i in 0..size {
        let j = assignment[i];
        let in_before = i < n;
        let in_after = j < m;
        match (in_before, in_after) {
            (true, true) => {
                let cost = matrix[i][j];
                if cost > REWORD_THRESHOLD {
                    ops.push(Op::Deleted {
                        index: i,
                        text: summarize(&before[i]),
                    });
                    ops.push(Op::Added {
                        index: j,
                        text: summarize(&after[j]),
                    });
                } else if cost == 0.0 {
                    if i == j {
                        ops.push(Op::Kept {
                            index: i,
                            text: summarize(&before[i]),
                        });
                    } else {
                        ops.push(Op::Moved {
                            from: i,
                            to: j,
                            text: summarize(&before[i]),
                        });
                    }
                } else if i == j {
                    ops.push(Op::Reworded {
                        index: i,
                        score: cost,
                        text: summarize(&after[j]),
                    });
                } else {
                    ops.push(Op::MovedAndReworded {
                        from: i,
                        to: j,
                        score: cost,
                        text: summarize(&after[j]),
                    });
                }
            }
            (true, false) => ops.push(Op::Deleted {
                index: i,
                text: summarize(&before[i]),
            }),
            (false, true) => ops.push(Op::Added {
                index: j,
                text: summarize(&after[j]),
            }),
            (false, false) => {}
        }
    }
    ops
}

#[test]
fn prototype_1_block_hash_assignment() {
    for fixture in &["reword", "reorder", "insert"] {
        let (before_src, after_src) = load_fixture(fixture);
        let before = split_blocks(&before_src);
        let after = split_blocks(&after_src);

        println!(
            "\n=== Fixture: {fixture} ({} → {} blocks) ===",
            before.len(),
            after.len()
        );
        println!("Algorithm: block-hash + 2-opt assignment (Hungarian stand-in)");
        let ops = block_hash_assignment(&before, &after);
        print!("{}", render_ops(&ops));
    }
}

// ================================================================
// Prototype 3 — block-Myers.
//
// Tokenize each document as a sequence of blocks, run the classic
// LCS-based diff on those sequences (`similar::TextDiff::from_slices`),
// and emit kept/added/deleted per the walk. Myers has no native move
// detection, so a post-pass pairs same-content add/delete pairs into
// moves. Reworded blocks are not detected — they surface as delete+add,
// which is the memo's flagged failure mode.
// ================================================================

fn block_myers(before: &[String], after: &[String]) -> Vec<Op> {
    // Walk the diff once, collecting an interim list that preserves
    // the relative order the algorithm produced. Pending add/delete
    // entries carry their indices so the move post-pass can pair them
    // by content while the kept entries stay anchored in place.
    use similar::{ChangeTag, TextDiff};

    enum Interim {
        Kept { index: usize, text: String },
        Deleted { index: usize, text: String },
        Added { index: usize, text: String },
    }

    // `TextDiff::from_slices` takes `&[&T]`, so flatten the String
    // vectors into &str slices before handing them over.
    let before_refs: Vec<&str> = before.iter().map(String::as_str).collect();
    let after_refs: Vec<&str> = after.iter().map(String::as_str).collect();
    let diff = TextDiff::from_slices(&before_refs, &after_refs);
    let mut interim: Vec<Interim> = Vec::new();
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Equal => {
                // `old_index()` is the before-side position; this is a
                // kept block, so we index it by that. Using `new_index`
                // would be equally valid — both are always Some on Equal.
                let i = change.old_index().unwrap();
                interim.push(Interim::Kept {
                    index: i,
                    text: summarize(&before[i]),
                });
            }
            ChangeTag::Delete => {
                let i = change.old_index().unwrap();
                interim.push(Interim::Deleted {
                    index: i,
                    text: before[i].clone(),
                });
            }
            ChangeTag::Insert => {
                let j = change.new_index().unwrap();
                interim.push(Interim::Added {
                    index: j,
                    text: after[j].clone(),
                });
            }
        }
    }

    // Move post-pass. For each Added entry, find an earlier-or-later
    // Deleted entry with byte-identical content; mark both as part of
    // a move. Same-content matching is what the memo specifies; it's
    // the cheapest thing that stands a chance on the reorder fixture.
    // Worse on reworded sections because a reworded paragraph does
    // not have a byte-identical partner.
    let mut paired_delete: Vec<bool> = interim
        .iter()
        .map(|e| !matches!(e, Interim::Deleted { .. }))
        .collect();
    let mut move_pairs: Vec<(usize, usize)> = Vec::new(); // (delete_idx, add_idx) in `interim`
    for (add_idx, entry) in interim.iter().enumerate() {
        if let Interim::Added { index: j, .. } = entry {
            let added_src = &after[*j];
            // Find the earliest unpaired Deleted entry with the same
            // content. "Earliest" is arbitrary — the fixtures are
            // small enough that ambiguity doesn't arise. Production
            // code would use stable matching; for the memo we just
            // want to show the shape of the algorithm's output.
            for (del_idx, other) in interim.iter().enumerate() {
                if paired_delete[del_idx] {
                    continue;
                }
                if let Interim::Deleted { index: i, .. } = other {
                    if before[*i] == *added_src {
                        paired_delete[del_idx] = true;
                        move_pairs.push((del_idx, add_idx));
                        break;
                    }
                }
            }
        }
    }

    // A delete is "paired" iff its interim index shows up as the
    // delete side of a move_pair entry. Adds carry the same flag via
    // the second tuple element. Flatten both into sets so the render
    // loop can ask "is this entry the dead half of a move?".
    let delete_to_move: std::collections::HashMap<usize, usize> = move_pairs
        .iter()
        .map(|(d, a)| (*d, *a))
        .collect();
    let add_to_move: std::collections::HashMap<usize, usize> =
        move_pairs.iter().map(|(d, a)| (*a, *d)).collect();

    let mut ops: Vec<Op> = Vec::new();
    for (idx, entry) in interim.iter().enumerate() {
        match entry {
            Interim::Kept { index, text } => ops.push(Op::Kept {
                index: *index,
                text: text.clone(),
            }),
            Interim::Deleted { index, text } => {
                if let Some(partner_idx) = delete_to_move.get(&idx) {
                    // The move is rendered on the Added side so the
                    // transcript reads once per move, not twice. Skip
                    // here; we'll emit when we hit the Add.
                    let _ = partner_idx;
                    continue;
                }
                ops.push(Op::Deleted {
                    index: *index,
                    text: summarize(text),
                });
            }
            Interim::Added { index, text } => {
                if let Some(partner_idx) = add_to_move.get(&idx) {
                    // Find the original before-side index for the
                    // paired delete, so the Move op carries both ends.
                    let from = match &interim[*partner_idx] {
                        Interim::Deleted { index, .. } => *index,
                        _ => unreachable!(),
                    };
                    ops.push(Op::Moved {
                        from,
                        to: *index,
                        text: summarize(text),
                    });
                } else {
                    ops.push(Op::Added {
                        index: *index,
                        text: summarize(text),
                    });
                }
            }
        }
    }
    ops
}

// ================================================================
// Prototype 2 — Zhang-Shasha tree edit distance.
//
// Parse each document into a section tree (document → section-per-
// heading → paragraph leaves under that heading), run the classic
// Zhang-Shasha DP to compute the minimum edit script, and render the
// script as semantic ops. Moves aren't a native Zhang-Shasha output —
// a section that moved reads as subtree-delete + subtree-insert until
// a post-pass pairs the deleted subtree with the re-inserted one by
// label equality. Same shape as Prototype 1's move detection, just at
// the subtree level.
//
// The implementation is deliberately compact. Zhang-Shasha is ~80
// lines of forest-distance DP plus 40 lines of tree construction and
// post-order flattening; the post-pass to lift insert+delete pairs
// into moves is another ~30. Fine for the memo; the memo's point is
// whether the output quality justifies the extra implementation
// footprint over Prototype 1.
// ================================================================

/// Labeled ordered tree. Interior nodes carry a short label (e.g.
/// `"§ ## The Solution"`); leaf nodes carry the paragraph text. The
/// post-order flattening and cost metric treat every node uniformly
/// by label.
#[derive(Debug, Clone)]
struct Tree {
    label: String,
    children: Vec<Tree>,
}

/// Parse the fixture-shaped markdown into a section tree:
///   Root("document")
///     Section("§ # Heading") — one per H1
///       Section("§ ## Heading") — nested under H1
///         Paragraph("first words of the paragraph…")
///
/// Sections own their heading inline (the label encodes it) rather
/// than modeling the heading as a separate child node. That keeps the
/// post-order walk's cost metric aligned with how a human counts
/// edits: "change this heading" = relabel the section; "delete this
/// section" = delete one subtree, not "delete the heading *and* every
/// paragraph underneath."
fn parse_section_tree(source: &str) -> Tree {
    let blocks = split_blocks(source);
    let mut root = Tree {
        label: "document".to_string(),
        children: Vec::new(),
    };
    // Stack of (section level, node being built). The root stays at
    // depth 0; H1 pushes a level-1 frame, H2 a level-2, etc. A new
    // heading pops frames until the stack top has a shallower level.
    let mut stack: Vec<Tree> = Vec::new();
    let mut stack_levels: Vec<u8> = Vec::new();

    fn pop_into_parent(parent: &mut Tree, stack: &mut Vec<Tree>, stack_levels: &mut Vec<u8>) {
        if let Some(t) = stack.pop() {
            stack_levels.pop();
            if let Some(top) = stack.last_mut() {
                top.children.push(t);
            } else {
                parent.children.push(t);
            }
        }
    }

    for block in blocks {
        if let Some((level, text)) = parse_heading(&block) {
            while let Some(&top_level) = stack_levels.last() {
                if top_level >= level {
                    pop_into_parent(&mut root, &mut stack, &mut stack_levels);
                } else {
                    break;
                }
            }
            stack.push(Tree {
                label: format!("§ {} {}", "#".repeat(level as usize), text),
                children: Vec::new(),
            });
            stack_levels.push(level);
        } else {
            let leaf = Tree {
                label: summarize(&block),
                children: Vec::new(),
            };
            if let Some(top) = stack.last_mut() {
                top.children.push(leaf);
            } else {
                root.children.push(leaf);
            }
        }
    }
    while !stack.is_empty() {
        pop_into_parent(&mut root, &mut stack, &mut stack_levels);
    }
    root
}

fn parse_heading(block: &str) -> Option<(u8, String)> {
    let first_line = block.lines().next()?;
    let trimmed = first_line.trim_start();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = trimmed[hashes..].trim();
    if rest.is_empty() {
        return None;
    }
    Some((hashes as u8, rest.to_string()))
}

/// Post-order flattening with the auxiliary arrays Zhang-Shasha wants:
/// labels, leftmost-leaf descendant (`lmd`), and key roots. The key
/// roots are the DP's outer loop — every subtree's root shows up in
/// at least one key root's iteration.
struct Flat {
    labels: Vec<String>,
    lmd: Vec<usize>,
    key_roots: Vec<usize>,
}

fn flatten(tree: &Tree) -> Flat {
    let mut labels = Vec::new();
    let mut lmd = Vec::new();
    post_order(tree, &mut labels, &mut lmd);
    let n = labels.len();

    // Key roots: the highest-indexed node with each distinct `lmd`.
    // Collected via a map keyed by lmd value, then sorted ascending so
    // the DP visits subtrees bottom-up.
    let mut by_lmd: std::collections::BTreeMap<usize, usize> =
        std::collections::BTreeMap::new();
    for (i, l) in lmd.iter().enumerate() {
        by_lmd.insert(*l, i); // later entries with same lmd overwrite
    }
    let key_roots: Vec<usize> = {
        let mut v: Vec<usize> = by_lmd.values().copied().collect();
        v.sort();
        v
    };
    let _ = n; // silence unused-binding warning on pattern-match refactors
    Flat {
        labels,
        lmd,
        key_roots,
    }
}

/// Post-order walk that records each node's label and `lmd`. The `lmd`
/// of a leaf is the leaf itself; the `lmd` of an internal node is its
/// first child's `lmd`, threaded up from the left spine.
fn post_order(tree: &Tree, labels: &mut Vec<String>, lmd: &mut Vec<usize>) -> usize {
    let start = labels.len();
    let mut first_lmd: Option<usize> = None;
    for child in &tree.children {
        let child_lmd = post_order(child, labels, lmd);
        if first_lmd.is_none() {
            first_lmd = Some(child_lmd);
        }
    }
    let my_index = labels.len();
    labels.push(tree.label.clone());
    let my_lmd = first_lmd.unwrap_or(my_index);
    lmd.push(my_lmd);
    let _ = start;
    my_lmd
}

/// Zhang-Shasha forest-distance DP. Returns the tree-edit-distance
/// matrix `td` (one entry per (i, j) post-order pair) plus the
/// per-iteration forest-distance matrix `fd` from the *last* key-root
/// pair processed — enough to drive a backtracker that only ever
/// reconstructs one subtree at a time.
///
/// This is the textbook formulation: delete and insert cost 1 each,
/// relabel costs 0 when labels match else 1. For the fixture
/// transcripts that metric is fine; a production implementation would
/// swap in a fractional relabel cost based on Levenshtein distance so
/// a reworded paragraph costs less than a replaced one.
fn zhang_shasha(f1: &Flat, f2: &Flat) -> Vec<Vec<usize>> {
    let n = f1.labels.len();
    let m = f2.labels.len();
    let mut td = vec![vec![0usize; m + 1]; n + 1];

    // Outer loops iterate key roots — the DP visits each subtree root
    // once. Inner loops fill the `fd` forest-distance matrix for the
    // currently-considered pair of subtrees, reading out the
    // `td[i][j]` value at the subtree root.
    for &i in &f1.key_roots {
        for &j in &f2.key_roots {
            let li = f1.lmd[i];
            let lj = f2.lmd[j];
            let width = i - li + 1;
            let height = j - lj + 1;

            // fd[x][y] = forest-distance for the forest ending at
            // post-order index li+x-1 (or empty at x=0) vs lj+y-1.
            let mut fd = vec![vec![0usize; height + 1]; width + 1];
            for x in 1..=width {
                fd[x][0] = fd[x - 1][0] + 1;
            }
            for y in 1..=height {
                fd[0][y] = fd[0][y - 1] + 1;
            }

            for x in 1..=width {
                for y in 1..=height {
                    let pi = li + x - 1;
                    let pj = lj + y - 1;
                    let cost_relabel = if f1.labels[pi] == f2.labels[pj] { 0 } else { 1 };
                    let del = fd[x - 1][y] + 1;
                    let ins = fd[x][y - 1] + 1;

                    if f1.lmd[pi] == li && f2.lmd[pj] == lj {
                        fd[x][y] = del.min(ins).min(fd[x - 1][y - 1] + cost_relabel);
                        td[pi][pj] = fd[x][y];
                    } else {
                        let prev_x = f1.lmd[pi] - li;
                        let prev_y = f2.lmd[pj] - lj;
                        fd[x][y] = del.min(ins).min(fd[prev_x][prev_y] + td[pi][pj]);
                    }
                }
            }
        }
    }

    td
}

#[derive(Debug, Clone)]
enum RawEdit {
    Match { i: usize, j: usize },
    Relabel { i: usize, j: usize },
    Delete { i: usize },
    Insert { j: usize },
}

/// Backtrack an edit script from the root pair. Runs the forest DP
/// once per subtree pair on the optimal path; slower than caching the
/// per-pair `fd` matrices but far simpler and plenty fast on the
/// fixtures. Recursion follows the standard Zhang-Shasha backtrack:
/// at each cell choose whichever min option yielded the current
/// value, preferring relabel/match when ties exist so runs of equal
/// labels surface as matches rather than delete+insert chains.
fn extract_script(f1: &Flat, f2: &Flat) -> Vec<RawEdit> {
    let n = f1.labels.len();
    let m = f2.labels.len();
    if n == 0 && m == 0 {
        return Vec::new();
    }
    let td = zhang_shasha(f1, f2);
    let mut script = Vec::new();
    backtrack_tree(f1, f2, n.wrapping_sub(1), m.wrapping_sub(1), &td, &mut script);
    script.reverse();
    script
}

fn backtrack_tree(
    f1: &Flat,
    f2: &Flat,
    root_i: usize,
    root_j: usize,
    td: &[Vec<usize>],
    out: &mut Vec<RawEdit>,
) {
    // Root indices can overflow when one tree is empty; guard with
    // explicit "past-the-end" signals.
    let i_empty = root_i == usize::MAX;
    let j_empty = root_j == usize::MAX;
    if i_empty && j_empty {
        return;
    }
    if i_empty {
        // Insert the whole of tree 2's subtree under root_j.
        for j in f2.lmd[root_j]..=root_j {
            out.push(RawEdit::Insert { j });
        }
        return;
    }
    if j_empty {
        for i in f1.lmd[root_i]..=root_i {
            out.push(RawEdit::Delete { i });
        }
        return;
    }
    let li = f1.lmd[root_i];
    let lj = f2.lmd[root_j];
    let width = root_i - li + 1;
    let height = root_j - lj + 1;

    // Rebuild the forest-distance matrix for this pair. The outer DP
    // already filled `td[root_i][root_j]` correctly, but we need
    // `fd[x][y]` positions to walk the path.
    let mut fd = vec![vec![0usize; height + 1]; width + 1];
    for x in 1..=width {
        fd[x][0] = fd[x - 1][0] + 1;
    }
    for y in 1..=height {
        fd[0][y] = fd[0][y - 1] + 1;
    }
    for x in 1..=width {
        for y in 1..=height {
            let pi = li + x - 1;
            let pj = lj + y - 1;
            let cost_relabel = if f1.labels[pi] == f2.labels[pj] { 0 } else { 1 };
            if f1.lmd[pi] == li && f2.lmd[pj] == lj {
                let del = fd[x - 1][y] + 1;
                let ins = fd[x][y - 1] + 1;
                fd[x][y] = del.min(ins).min(fd[x - 1][y - 1] + cost_relabel);
            } else {
                let prev_x = f1.lmd[pi] - li;
                let prev_y = f2.lmd[pj] - lj;
                let del = fd[x - 1][y] + 1;
                let ins = fd[x][y - 1] + 1;
                fd[x][y] = del.min(ins).min(fd[prev_x][prev_y] + td[pi][pj]);
            }
        }
    }

    // Backtrack from (width, height) down to (0, 0).
    let mut x = width;
    let mut y = height;
    while x > 0 || y > 0 {
        if x == 0 {
            out.push(RawEdit::Insert { j: lj + y - 1 });
            y -= 1;
            continue;
        }
        if y == 0 {
            out.push(RawEdit::Delete { i: li + x - 1 });
            x -= 1;
            continue;
        }
        let pi = li + x - 1;
        let pj = lj + y - 1;
        let cost_relabel = if f1.labels[pi] == f2.labels[pj] { 0 } else { 1 };
        let matches_root = f1.lmd[pi] == li && f2.lmd[pj] == lj;

        // Try match/relabel first so equal labels don't degenerate to
        // delete+insert pairs. The memo's reorder transcript shows
        // the downside of this preference: a structural swap
        // (section A moves, section B moves into its slot) surfaces
        // as a chain of relabels rather than as moves, because
        // Zhang-Shasha's classical formulation has no native move
        // operation and relabel is unit-cost. Swap-chain post-
        // processing would lift those into moves; not implemented
        // here — it'd add ~50 lines of algorithm-specific post-pass
        // code, which is exactly the effort asymmetry the memo
        // weighs against Zhang-Shasha in the final pick.
        if matches_root && fd[x][y] == fd[x - 1][y - 1] + cost_relabel {
            if cost_relabel == 0 {
                out.push(RawEdit::Match { i: pi, j: pj });
            } else {
                out.push(RawEdit::Relabel { i: pi, j: pj });
            }
            x -= 1;
            y -= 1;
            continue;
        }
        if !matches_root {
            let prev_x = f1.lmd[pi] - li;
            let prev_y = f2.lmd[pj] - lj;
            if fd[x][y] == fd[prev_x][prev_y] + td[pi][pj] {
                // Recurse into the sub-pair (pi, pj) then jump to its
                // left edge in the current forest.
                backtrack_tree(f1, f2, pi, pj, td, out);
                x = prev_x;
                y = prev_y;
                continue;
            }
        }
        if fd[x][y] == fd[x - 1][y] + 1 {
            out.push(RawEdit::Delete { i: pi });
            x -= 1;
        } else {
            out.push(RawEdit::Insert { j: pj });
            y -= 1;
        }
    }
}

/// Lift the raw edit script into semantic ops. Deleted subtrees with a
/// byte-identical inserted counterpart become `Moved`; relabeled nodes
/// become `Reworded`. `Match` with equal labels is `Kept`. Other
/// leftovers stay as `Added`/`Deleted`.
fn zhang_shasha_ops(tree1: &Tree, tree2: &Tree) -> Vec<Op> {
    let f1 = flatten(tree1);
    let f2 = flatten(tree2);
    let script = extract_script(&f1, &f2);

    // Index paired moves so we can emit each once in post-order of
    // the after tree (so the transcript reads in document order).
    let mut paired_delete = vec![false; f1.labels.len()];
    let mut paired_insert = vec![false; f2.labels.len()];
    let mut move_pairs: Vec<(usize, usize)> = Vec::new();
    for e in &script {
        if let RawEdit::Insert { j } = e {
            // Find the earliest still-unpaired delete with the same
            // label. Same pairing rule as Prototype 3 — same-content
            // moves only. Reworded subtrees wouldn't match here; they
            // surface via `Relabel` instead when the subtree roots
            // are the same but their labels differ.
            let added = &f2.labels[*j];
            if let Some(del_i) = script.iter().find_map(|e2| {
                if let RawEdit::Delete { i } = e2 {
                    if !paired_delete[*i] && f1.labels[*i] == *added {
                        return Some(*i);
                    }
                }
                None
            }) {
                paired_delete[del_i] = true;
                paired_insert[*j] = true;
                move_pairs.push((del_i, *j));
            }
        }
    }

    let mut ops = Vec::new();
    for e in &script {
        match e {
            RawEdit::Match { i: _, j } => ops.push(Op::Kept {
                index: *j,
                text: f2.labels[*j].clone(),
            }),
            RawEdit::Relabel { i, j } => {
                // Relabel is Zhang-Shasha's reworded: same structural
                // position, different label. The memo's reworded op
                // expects a numeric score; synthesize one from the
                // character-level distance of the two labels so the
                // transcript is comparable to Prototype 1's scores.
                let score = block_distance(&f1.labels[*i], &f2.labels[*j]);
                ops.push(Op::Reworded {
                    index: *j,
                    score,
                    text: f2.labels[*j].clone(),
                });
            }
            RawEdit::Delete { i } => {
                if paired_delete[*i] {
                    continue; // emitted on the Insert side
                }
                ops.push(Op::Deleted {
                    index: *i,
                    text: f1.labels[*i].clone(),
                });
            }
            RawEdit::Insert { j } => {
                if let Some((from, _)) = move_pairs.iter().find(|(_, to)| *to == *j) {
                    ops.push(Op::Moved {
                        from: *from,
                        to: *j,
                        text: f2.labels[*j].clone(),
                    });
                } else {
                    ops.push(Op::Added {
                        index: *j,
                        text: f2.labels[*j].clone(),
                    });
                }
            }
        }
    }
    ops
}

#[test]
fn prototype_2_zhang_shasha() {
    for fixture in &["reword", "reorder", "insert"] {
        let (before_src, after_src) = load_fixture(fixture);
        let tree1 = parse_section_tree(&before_src);
        let tree2 = parse_section_tree(&after_src);
        let f1 = flatten(&tree1);
        let f2 = flatten(&tree2);

        println!(
            "\n=== Fixture: {fixture} (tree {} → {} nodes) ===",
            f1.labels.len(),
            f2.labels.len()
        );
        println!("Algorithm: Zhang-Shasha tree edit distance + same-label move post-pass");
        let ops = zhang_shasha_ops(&tree1, &tree2);
        print!("{}", render_ops(&ops));
    }
}

#[test]
fn prototype_3_block_myers() {
    for fixture in &["reword", "reorder", "insert"] {
        let (before_src, after_src) = load_fixture(fixture);
        let before = split_blocks(&before_src);
        let after = split_blocks(&after_src);

        println!(
            "\n=== Fixture: {fixture} ({} → {} blocks) ===",
            before.len(),
            after.len()
        );
        println!("Algorithm: block-Myers (LCS) + same-content move post-pass");
        let ops = block_myers(&before, &after);
        print!("{}", render_ops(&ops));
    }
}
