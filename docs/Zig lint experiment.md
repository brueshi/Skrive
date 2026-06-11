# Zig Lint Engine Experiment

**Status.** Scoped. Gated on diff core experiment graduating.

**Goal.** Reimplement Skrive's structural lint engine as a Zig library called from Rust via C ABI. Use the five rules defined in `.skrive.toml` as the surface, fixture-driven correctness as the oracle, and the existing Rust implementation as the performance baseline.

**Why this, after the diff core.** The lint engine is where Zig's distinctive features (comptime rule dispatch, allocator-per-pass discipline) pay off in ways the diff core doesn't exercise. It's the second calibration point in the portfolio: smaller in scope than the diff core, more varied in rule shape, and continuously hot in real use (lint runs as the user edits, not just on demand). If the diff core graduated, this experiment tells you whether Zig stays compelling on a different shape of problem.

**This is an experiment, not a commitment.** Same exit conditions as the diff core. Read them before starting.

## Prerequisites

- Diff core experiment must have graduated (clear win, not instructive failure)
- The lint engine has been extracted from `src-tauri` into its own Rust crate first — this is a refactor that delivers value regardless of whether Zig wins
- A fixture harness exists: at least three project-shaped test fixtures with expected lint output for each of the five rules

If those prerequisites aren't in place, do the Rust-side extraction work first. That work is valuable on its own and required either way.

## Scope

### In

- A standalone Zig library, `libskrive_lint`, building to `.dylib` on macOS and `.dll` on Windows
- C-ABI surface: run-all-rules-on-project, free results, iterate findings
- Zig implementations of all five rules from `docs/skrive-toml-reference.md`:
  - `broken_internal_links`
  - `missing_required_frontmatter`
  - `heading_hierarchy`
  - `orphaned_files`
  - `duplicate_headings`
- Severity configuration parsed from `.skrive.toml` and respected per-rule
- A thin Rust wrapper crate (`skrive-lint-zig`) producing the same `LintResult` shape as the existing Rust implementation
- Cargo feature flag in `src-tauri` (`lint-zig`) that swaps the implementation at build time. Default off.
- Fixture parity: Zig and Rust produce identical findings on every fixture, with identical severity, line numbers, and messages
- A benchmark on a synthetic 200-file project, measuring wall-clock time, peak allocation, and incremental-edit latency
- Results memo (`docs/zig-lint-results.md`) following the same format as the diff results memo

### Out

- New lint rules beyond the five in `.skrive.toml`
- The frontmatter parser (assume it's already extracted as a shared dependency both implementations use)
- The Markdown parser (assume same)
- Live-reload of `.skrive.toml` (a separate roadmap item)
- Editor-surface integration changes (gutter markers, lint panel UI all stay identical)
- IDE-style quick fixes or auto-corrections

## FFI surface

Designed around the project-as-input shape rather than file-by-file. The lint engine's natural unit is the project, because rules like `orphaned_files` and `broken_internal_links` are inherently cross-file.

```c
// Run all configured rules against a project. Returns NULL on failure.
SkriveLintResult* skrive_lint_run(
    const SkriveProjectSnapshot* project,
    const SkriveLintConfig* config
);

// Free a result.
void skrive_lint_free(SkriveLintResult* result);

// Iterate findings.
size_t skrive_lint_finding_count(const SkriveLintResult* result);
const SkriveLintFinding* skrive_lint_findings(const SkriveLintResult* result);
```

`SkriveProjectSnapshot` is a flat structure: an array of file records, each with a path, content pointer, and parsed-frontmatter handle. The Rust side builds this snapshot from its existing project state and passes it across the FFI boundary as a single allocation. This is a deliberate design choice — keeping the per-call FFI cost low even as the rule count grows.

`SkriveLintConfig` carries the per-rule severity and the required-frontmatter field list.

## Implementation plan

Time-boxed, four weekends maximum. Each step has a stop-and-assess gate.

### Step 1 — Rust-side extraction 

Before any Zig work. This is real refactoring that ships either way.

- Move the lint engine out of `src-tauri` into a new `skrive-lint` crate
- Define the `LintResult`, `Finding`, and `Config` types as the canonical shape
- Build the fixture harness: three project-shaped fixtures (small clean project, project with violations of every rule, project with edge cases like circular references and unicode paths)
- Verify the existing implementation passes against the fixtures
- **Gate.** The Rust extraction is valuable independent of Zig. If this weekend produces a clean crate with passing fixtures, the experiment has already delivered an architecture win even if the Zig phases never start.

### Step 2 — Zig skeleton and one rule 

- Stand up `skrive-lint-zig/` with `build.rs` invoking `zig build`, mirroring the diff library's pattern
- Implement the FFI surface scaffolding: project snapshot ingestion, config parsing, finding emission
- Port `duplicate_headings` first — it's the simplest rule, single-file scope, no cross-file logic
- Validate against fixtures: Zig output exactly matches Rust output on the duplicate-headings rule
- **Gate.** One rule end-to-end through FFI by end of weekend two. If the FFI scaffolding takes longer than the rule itself, that's a signal — the diff core's FFI work was supposed to make this part cheap. Stop and reassess.

### Step 3 — Remaining four rules 

- Port `heading_hierarchy` (single-file, structural)
- Port `missing_required_frontmatter` (single-file, config-driven)
- Port `broken_internal_links` (cross-file, requires building a path index)
- Port `orphaned_files` (cross-file, requires building a reverse-link index)
- Validate each against fixtures as it lands
- The cross-file rules are where allocator discipline matters most: the path index and reverse-link index are exactly the kind of intermediate structure that benefits from arena allocation
- **Gate.** Fixture parity on all five rules. If any rule diverges from the Rust output, stop and decide: debug, or call the experiment partially-instructive and write that up.

### Step 4 — Benchmark and write-up 

- Generate a synthetic 200-file project. Two variants: clean (all rules pass) and adversarial (every rule has multiple violations across many files)
- Benchmark full-project lint with `criterion` on the Rust side and `std.time.Timer` on the Zig side. Measure wall-clock and peak allocation for both variants.
- Benchmark incremental-edit latency: change one file, re-run lint, measure. This is the metric that matters most for shipped behavior because it's what runs continuously.
- Write `docs/zig-lint-results.md`: fixture transcripts, benchmark tables, what comptime delivered, what the cross-file rules taught about allocator strategy, decision recommendation.
- **Gate.** Total elapsed time is four weekends, five at the outside. If it stretches past five, the time itself is the result.

## Where comptime should earn its keep

The lint engine is the first place in the experiment portfolio where Zig's comptime is genuinely the right tool, not just a curiosity. Specific places to use it:

The rule registry is a comptime list. Each rule is a struct with a name, a severity field name in `.skrive.toml`, and a function pointer. The dispatch table is generated at compile time from this list. Adding a sixth rule is a matter of adding one entry to the list — no runtime registration, no string-based dispatch, no map lookups during the hot path.

The severity-to-output-style mapping is comptime. The lint engine knows at compile time which severity levels exist and how each maps to the gutter marker shape, the panel entry style, and the count category. This eliminates a class of runtime branching in the rendering loop.

The required-frontmatter field check uses comptime hashing for the standard field names. A user-configured custom field falls through to runtime hashing, but the common case is decided at compile time.

If after Step 3 you find yourself not using comptime for any of these, that's a signal — Zig didn't deliver its distinctive value on this surface, which is a meaningful data point for the framework decision.

## Where allocator discipline should earn its keep

The cross-file rules are where this matters. A 200-file project will allocate thousands of small intermediate records during a full lint pass: per-file heading lists, per-file frontmatter records, the global path index, the global reverse-link index, the findings list itself. In Rust you reach for `Vec` and `HashMap` and the global allocator handles everything. In Zig, the right shape is:

An arena allocator scoped to the entire lint run. All intermediate structures (heading lists, link records, path index entries) live in this arena. Freed all at once when the lint run completes.

A separate allocator for the findings, which outlive the lint run because the caller iterates them after the engine returns. These are caller-owned and freed via `skrive_lint_free`.

If the implementation drifts away from this pattern — if you find yourself reaching for `std.heap.page_allocator` everywhere out of habit — that's a sign the discipline isn't translating, which is also a meaningful data point.

## Exit conditions

Same three outcomes as the diff core experiment.

**Graduates.** Zig wins measurably (faster full-project lint, faster incremental-edit latency, lower peak allocation, or measurably cleaner code for the cross-file rules), and the comptime discipline felt productive. The library stays behind the feature flag. The next experiment is the link graph. This is the second supporting data point for the substrate intuition, not a commitment.

**Instructive failure.** Zig is the same speed, or comptime didn't pay off, or the FFI overhead per call was too high for the incremental-edit case. Write the results memo. Delete the Zig library or tag it. The framework rebuild question gets a negative data point on a more demanding surface than the diff core, which is more informative than a negative data point on a simpler surface would have been.

**Out of scope.** You started adding new lint rules, or rewriting the frontmatter parser "while you're in there," or extracting the Markdown parser. Stop. Revert. Each experiment is one extraction, no more.

## What lands in shipped Skrive regardless

- The lint engine extracted into its own crate, separable from `src-tauri`. Step 1 delivers this independent of Zig's outcome.
- A project-fixture harness for lint, runnable in CI. Reusable for any future rule additions.
- A benchmark suite for incremental-edit latency. Useful for the editor-surface performance work whether or not Zig wins.
- Documented patterns for cross-file analysis with deterministic output. Reusable for the link graph experiment.

## References

- `docs/skrive-toml-reference.md` — the five rules, severity model, and config schema
- `src-tauri/src/lint.rs` (or equivalent) — current Rust implementation, the comparison target
- `docs/ledger-criteria.md` — the parallel substrate-question artifact
- `docs/zig-diff-results.md` — predecessor experiment's writeup, shapes this one's format

## Decision rule

If after Step 3 the Zig implementation matches Rust on all five rules but the benchmark in Step 4 shows no measurable improvement, that's still useful — it means Zig is approximately equivalent on this surface, which informs the framework decision differently than a clear win would. Write it up honestly. "Zig and Rust are equivalent for this kind of work" is a real result.

If the comptime work didn't materially improve the implementation over what Rust would do with macros or generics, write that up explicitly. The point of the experiment is to learn whether Zig's distinctive features deliver on Skrive's specific problems, not to confirm a hypothesis.

## What this is not

- A migration plan
- A commitment to Zig
- A prerequisite for any other Skrive work
- A replacement for the diff core results memo

This is the second of three calibration experiments. Treat it as such.