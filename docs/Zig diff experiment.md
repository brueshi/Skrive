# Zig Diff Library Experiment

**Status.** Scoped. Not started.

**Goal.** Reimplement Skrive's structural diff algorithm (Prototype 1: block-hash + assignment) as a Zig library called from Rust via C ABI. Use the existing fixtures as the correctness oracle and the existing Rust implementation as the performance baseline.

**Why this, not something else.** The diff core is the only piece of Skrive that's a pure function with documented expected outputs, no I/O, no Tauri coupling, and a non-trivial algorithm. It's the cleanest possible test surface for Zig's strengths (manual allocators, comptime, FFI discipline) without dragging in any framework-level concerns. It also delivers a real architecture improvement: extracting the algorithm from the Tauri-bound crate and freeing headroom for the algorithm memo's follow-ups.

**This is an experiment, not a commitment.** The deletion criterion is in `Exit conditions` below. Read it before starting.

## Scope

### In

- A standalone Zig library, `libskrive_diff`, building to `.dylib` on macOS and `.dll` on Windows
- C-ABI surface exposing two functions: compute a diff, free the result
- A Zig implementation of Prototype 1 from `docs/3.3-algorithm-memo.md` — block splitting, hashing, cost matrix, 2-opt assignment, operation reconstruction, reword threshold at 0.55
- A thin Rust wrapper crate (`skrive-diff-zig`) wrapping the FFI surface and producing the same `DiffResult` shape as the existing Rust `compute_diff`
- A Cargo feature flag in `src-tauri` (`diff-zig`) that swaps the implementation at build time. Default off.
- Fixture parity: the Zig implementation matches the Rust transcripts on `reword`, `reorder`, `insert` exactly
- A benchmark comparing the two implementations on a synthetic 1000-block document, measuring wall-clock time and peak allocation
- A short results memo (`docs/zig-diff-results.md`) following the same format as the algorithm memo

### Out

- Zhang-Shasha or Block-Myers in Zig (Prototype 1 only)
- The real Hungarian matcher follow-up (stick with 2-opt to match the Rust baseline; that's a separate algorithm question)
- Word-level intra-block reword diff
- Move-grouping post-pass (algorithm memo follow-up; not part of this scope)
- Anything frontend-facing — the Tauri command, the TypeScript types, the Svelte renderer all stay identical
- Cross-platform CI integration (build manually on each platform; CI integration is a follow-up if the experiment graduates)
- Replacing other Rust modules in Zig (frontmatter parser, link graph, lint engine — out of scope, full stop)

## FFI surface

Two functions, opaque result handle, caller-frees pattern.

```c
// Compute a diff. Returns NULL on allocation failure.
// `before` and `after` must be valid UTF-8, null-terminated.
SkriveDiffResult* skrive_diff_compute(const char* before, const char* after);

// Free a result returned by skrive_diff_compute.
void skrive_diff_free(SkriveDiffResult* result);

// Iteration: returns operation count and a pointer to a contiguous array.
// The pointer remains valid until skrive_diff_free is called.
size_t skrive_diff_op_count(const SkriveDiffResult* result);
const SkriveDiffOp* skrive_diff_ops(const SkriveDiffResult* result);
```

`SkriveDiffOp` is a packed struct with the operation kind, before-index, after-index, and a content pointer + length pair. Strings are owned by the result; the caller copies them out before calling free.

The Rust wrapper materializes the C struct array into the existing `DiffResult` shape on the Rust side. The Tauri command and the frontend see no change.

## Implementation plan

Time-boxed. Each step has a stop-and-assess gate.

### Step 1 — Toolchain and skeleton

- Install Zig (current stable). Confirm `zig build-lib` produces a working `.dylib` on macOS.
- Stand up `skrive-diff-zig/` as a Cargo crate with a `build.rs` that invokes `zig build` and links the resulting artifact.
- Smoke test: a Zig function that returns `42`, called from a Rust integration test, returns `42`.
- **Gate.** If toolchain integration takes more than half a weekend, the experiment is mispriced. Stop and reassess.

### Step 2 — Algorithm port

- Port `split_blocks` to Zig. Validate against the Rust output for the three fixtures by printing block lists and diffing them.
- Port the cost matrix construction. Same validation: print and diff.
- Port the 2-opt assignment loop. Same validation.
- Port the operation reconstruction. End-to-end now: feed each fixture's before/after, print the operation list, diff against the Rust transcripts in the algorithm memo.
- **Gate.** Fixture parity by end of weekend two. If the Zig output doesn't match exactly, stop and decide: debug, or call the experiment instructive-but-failed and write that up.

### Step 3 — FFI hardening 

- Implement the C ABI surface above
- Add a Rust integration test that runs all three fixtures through the FFI boundary and asserts the operation list matches the native Rust output exactly
- Add the `diff-zig` feature flag in `src-tauri` and confirm Skrive builds and runs identically with it on
- **Gate.** Skrive's existing diff tests pass with the flag on. If they don't, stop and debug — shipping a half-broken demo surface was the explicit lesson from the 3.3 renderer attempt.

### Step 4 — Benchmark and write-up 

- Generate a synthetic 1000-block fixture. Two variants: one with mostly kept blocks and a few reworded, one with significant reordering.
- Benchmark both implementations with `criterion` on the Rust side and `std.time.Timer` on the Zig side. Measure wall-clock and peak allocation.
- Write `docs/zig-diff-results.md` in the same format as the algorithm memo: fixture transcripts, benchmark table, what worked, what was painful, decision recommendation.
- **Gate.** Total elapsed time should be three weekends, four at the outside. If it stretches past that, the time itself is the result and goes in the write-up.

## Exit conditions

The experiment ends in one of three ways. Pick honestly.

**Graduates.** Zig wins on a measurable axis (speed, allocation, code clarity for the algorithm), and the FFI boundary work felt proportionate. The library stays in the codebase behind the feature flag. The next experiment is either the move-grouping post-pass in Zig or extracting a second module. This is *not* a commitment to the framework rebuild; it is an indication that the substrate intuition has one supporting data point.

**Instructive failure.** Zig is the same speed or slower, or the FFI boundary cost more time than it should have, or the toolchain bit harder than expected. Write the results memo. Delete the Zig library or leave it tagged in git for reference. The framework rebuild question gets a *negative* data point, which is just as useful. Don't rationalize.

**Out of scope.** The experiment expanded. You started adding a frontmatter parser, or a link graph, or "while I'm in here." Stop. Revert the additions. The point of the contained experiment is the contained part. Scope creep here is the same disease that kills custom frameworks at scale.

## What this is not

- A migration plan
- A commitment to Zig
- A decision about Tauri
- A replacement for the ledger work in `docs/ledger-criteria.md`

The ledger tracks whether Tauri is the wrong substrate. This experiment tracks whether Zig is the right replacement, on a contained surface. Both are needed. Neither alone decides.

## What lands in shipped Skrive regardless

- The structural diff algorithm extracted into its own crate, separable from `src-tauri`. This is a structural improvement whether or not the Zig version graduates.
- A benchmark harness for the diff core, runnable in CI. Useful for any future algorithm follow-up.
- A documented FFI pattern that future Zig-or-not experiments can reuse.

These are the architecture wins that justify the time even if the Zig side fails.

## References

- `docs/3.3-algorithm-memo.md` — Prototype 1 description, fixtures, expected transcripts, runtime baseline
- `src-tauri/src/diff.rs` — current Rust implementation, the comparison target
- `docs/ledger-criteria.md` — the parallel substrate-question artifact this experiment feeds into
- `docs/fixtures/3.3/` — the correctness oracle

## Decision rule

If after Step 2 the Zig implementation doesn't match transcripts on all three fixtures, stop. Don't push through. Either the port is wrong (debug it) or Zig is fighting you in a way the rest of the experiment won't reveal anything new about (write up and stop).

If after Step 4 the results memo doesn't include either a clear win or a clear loss, the experiment was mis-scoped — write that up too. Ambiguous experiments are worth less than decisive failures.