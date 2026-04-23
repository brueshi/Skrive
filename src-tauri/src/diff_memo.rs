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

/// Location of the fixture files, relative to `src-tauri/Cargo.toml`.
fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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
