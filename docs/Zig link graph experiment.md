# Zig Link Graph Experiment

**Status.** Scoped. Gated on diff core and lint engine experiments graduating.

**Goal.** Reimplement Skrive's link graph builder as a Zig library called from Rust via C ABI. Use the existing project fixtures as the correctness oracle and the existing Rust implementation as the performance baseline.

**Why this, third in the portfolio.** The link graph is the most demanding of the three experiments in terms of stateful data structures, lifetime management, and performance sensitivity. It runs on every project open and on every file change. It's the closest analog in current Skrive to the kind of memory discipline a custom framework would require everywhere. Two graduated experiments precede this one for a reason: by the time you start, you're calibrated on Zig in your codebase, you've shipped FFI patterns that work, and you have a baseline for what "Zig wins" or "Zig doesn't win" looks like in concrete numbers.

**This is the most informative experiment for the framework decision.** If Zig graduates here, on this shape of problem, the substrate intuition has its strongest supporting data point. If it doesn't, that's the most decisive negative result possible — because if Zig can't beat Rust on a stateful, allocation-heavy, performance-sensitive piece of Skrive, the framework rebuild's case is much weaker than it looks.

## Prerequisites

- Diff core experiment graduated
- Lint engine experiment graduated (or instructively failed in a way that doesn't undermine Zig as a tool — only the comptime discipline)
- The link graph has been extracted from `src-tauri` into its own Rust crate (`skrive-link-graph`)
- A fixture harness exists with at least four project shapes: small (10 files), medium (100 files), large (500 files), and adversarial (cycles, deep nesting, unicode paths, broken links by design)

If the Rust extraction hasn't happened, do it first. It's valuable independent of Zig.

## Scope

### In

- A standalone Zig library, `libskrive_link_graph`, building to `.dylib` on macOS and `.dll` on Windows
- C-ABI surface: build graph from project, query backlinks for a file, query outgoing links for a file, query dead links across project, free results
- Zig implementation of the full link graph: wiki-link parsing (`[[target]]` and `[[target|alias]]`), Markdown link parsing (`[label](target)`), reference-style link resolution (`[label][ref]` plus the `[ref]:` definitions), path resolution (relative and absolute), the forward and reverse adjacency structures
- A thin Rust wrapper crate (`skrive-link-graph-zig`) producing the same `LinkGraph` shape as the existing Rust implementation
- Cargo feature flag in `src-tauri` (`link-graph-zig`) that swaps the implementation at build time. Default off.
- Fixture parity: Zig and Rust produce identical adjacency structures on every fixture, with identical handling of edge cases (duplicate links, self-references, broken links, cycles)
- Benchmarks on all four fixture sizes: full-build wall-clock, full-build peak allocation, incremental-update latency (one file changes, graph updates), query latency (backlinks, outgoing, dead links)
- Results memo (`docs/zig-link-graph-results.md`)

### Out

- Rename-with-references logic (separate concern, depends on the graph but isn't part of building it)
- The link graph UI (backlinks panel, link visualization — all stays identical)
- Embedded link types beyond Markdown's standard set (no Obsidian-specific block references, no transclusion semantics)
- Watching the filesystem for changes (the watcher stays in Rust; Zig only rebuilds when called)
- Persistence of the graph between sessions (rebuild on open, same as today)

## FFI surface

The link graph is the most stateful of the three experiments. The graph itself is the long-lived object; queries against it are the hot path. The FFI surface reflects this.

```c
// Build a link graph from a project snapshot. Returns NULL on failure.
SkriveLinkGraph* skrive_link_graph_build(const SkriveProjectSnapshot* project);

// Update the graph for a single file that changed. Mutates in place.
// Returns false on allocation failure (graph is left in a consistent state).
bool skrive_link_graph_update_file(
    SkriveLinkGraph* graph,
    const char* file_path,
    const char* new_content
);

// Free the graph.
void skrive_link_graph_free(SkriveLinkGraph* graph);

// Query: backlinks for a file. Returns array of file paths.
SkriveLinkSet* skrive_link_graph_backlinks(const SkriveLinkGraph* graph, const char* file_path);

// Query: outgoing links from a file.
SkriveLinkSet* skrive_link_graph_outgoing(const SkriveLinkGraph* graph, const char* file_path);

// Query: all dead links in the project.
SkriveLinkSet* skrive_link_graph_dead_links(const SkriveLinkGraph* graph);

// Free a query result.
void skrive_link_set_free(SkriveLinkSet* set);
```

The graph is a long-lived opaque handle. Queries return short-lived sets that the caller frees. This shape mirrors how the Rust side already uses the graph — build once, query many, update on file change.

## Implementation plan

Time-boxed, five weekends maximum. This is the largest of the three experiments and its budget reflects that.

### Step 1 — Rust-side extraction 

Before any Zig work.

- Move the link graph out of `src-tauri` into a new `skrive-link-graph` crate
- Define the canonical types: `LinkGraph`, `Link`, `LinkKind`, query result shapes
- Build the four-fixture harness (small, medium, large, adversarial)
- Verify the existing implementation passes against fixtures
- **Gate.** Clean crate, passing fixtures, ready to compare against. If this weekend exposes that the existing Rust implementation has bugs you didn't know about, fix them in Rust before starting Zig — comparing against a buggy baseline is worse than not comparing.

### Step 2 — Zig parser and skeleton 

- Stand up `skrive-link-graph-zig/` with `build.rs` invoking `zig build`
- Implement the FFI scaffolding: project snapshot ingestion, opaque graph handle, query result allocation
- Port the link parser: wiki-links, Markdown links, reference-style links, path resolution
- Validate parser output against fixtures: every link extracted from every file matches the Rust parser exactly
- **Gate.** Parser parity end-to-end by end of weekend two. If the parser is taking longer than this, the experiment is mispriced — the parser is the simplest part. Stop and reassess.

### Step 3 — Graph construction 

- Build the forward adjacency structure (file -> outgoing links)
- Build the reverse adjacency structure (file -> backlinks)
- Build the dead-link index (links whose target doesn't resolve to an existing file)
- Validate against fixtures: full graph state matches Rust output for all four fixture sizes
- This is where the allocator strategy gets tested. The forward and reverse adjacency structures are the long-lived state; everything else is intermediate
- **Gate.** Full graph parity on all four fixtures. The adversarial fixture is the test that matters most — if Zig diverges on cycles or unicode paths or deeply-nested references, debug or call the experiment partially-instructive.

### Step 4 — Incremental updates and queries 

- Implement `skrive_link_graph_update_file`: parse the new content, diff its links against the old set, update both adjacency structures
- Implement the three query functions
- Validate query parity: for every file in every fixture, backlinks and outgoing match Rust exactly
- Validate update correctness: for a sequence of edits, the resulting graph matches what a fresh build would produce
- **Gate.** Query parity and update correctness. This is also where memory leaks would show up — run the update path in a loop and watch peak allocation stabilize.

### Step 5 — Benchmark and write-up 

- Benchmark all four operations across all four fixture sizes:
  - Full build wall-clock
  - Full build peak allocation
  - Incremental update latency (single-file change in a 500-file project)
  - Query latency (cold and warm)
- Write `docs/zig-link-graph-results.md`: full benchmark tables, what allocator strategy delivered, what was painful, decision recommendation
- This is also the moment for the meta-writeup: how do the three experiments together inform the framework decision? That meta-writeup goes in `docs/zig-portfolio-results.md` as a synthesis document
- **Gate.** Total elapsed time is five weekends, six at the outside. If it stretches past six, the time is the result.

## Where allocator discipline should dominate

This is the experiment where Zig's allocator story has to earn its place or doesn't. Specific patterns the implementation should use:

The graph itself owns a single arena. All adjacency entries, all interned path strings, all link records live in this arena. The arena is reset only on full rebuild, never during incremental updates. This is the long-lived allocator.

Path strings are interned. Every file path in the project becomes an integer ID; the adjacency structures store IDs, not strings. The interning table is the only place where path strings exist as bytes. This is a 5-10x reduction in memory footprint over a naive Rust implementation that uses `String` everywhere.

Incremental updates use a scratch arena that's reset between calls. Parsing the new file content, diffing link sets, computing the delta — all temporary structures live in scratch and disappear when the update returns.

Query results use a per-call arena tied to the result handle. When the caller frees the result, the arena frees with it.

If the implementation drifts away from this pattern — if you find Zig's `std.heap.GeneralPurposeAllocator` showing up in the hot path because it's "easier" — that's the data point. Write it up. The discipline either translates from your domain understanding to your code or it doesn't.

## What "Zig wins" looks like here

The diff core's win condition was speed and allocation on a CPU-bound algorithm. The lint engine's win condition was comptime productivity and incremental-edit latency. The link graph's win condition is different and stricter:

A clear win requires Zig to be faster on full builds, lower in peak allocation by a measurable margin (at least 30% on the medium fixture), and faster on incremental updates. Plus the implementation has to feel cleaner — the long-lived-graph pattern is exactly where Rust's borrow checker tends to fight you, and if Zig's manual approach feels worse rather than better here, that's a signal.

A win on speed alone, without the allocation improvement, is not a win. The whole reason the link graph is the third experiment is that it's the most allocation-sensitive surface in Skrive. If Zig matches Rust on speed but doesn't reduce memory footprint, the framework decision gets a more nuanced data point than a binary win/loss.

## Exit conditions

Same three outcomes, weighted more heavily for the framework decision.

**Graduates.** Zig wins on speed, allocation, and incremental-update latency. The library stays behind the feature flag. The portfolio is complete: three experiments, three graduations, three supporting data points for the substrate intuition. At this point, the framework rebuild question is ready for a real decision based on the ledger and the case-for-zig document. The experiments did their job.

**Instructive failure.** Zig matches Rust or loses on at least one axis. This is the most informative possible negative result. The framework rebuild's case takes a serious hit because the link graph is the closest analog to framework-level memory discipline in current Skrive. Write up the results carefully — both the technical findings and what they mean for the larger decision. Stay on Tauri. The Zig libraries from earlier experiments either stay as feature-flagged optimizations (if they delivered standalone wins) or get retired.

**Out of scope.** You started building rename-with-references in Zig, or extracting the Markdown parser, or "while I'm here." Stop. Revert. The portfolio's value depends on each experiment being contained.

## What lands in shipped Skrive regardless

- The link graph extracted into its own crate, separable from `src-tauri`. Step 1 delivers this independent of Zig's outcome.
- A four-fixture project harness for graph testing. Reusable for the eventual rename-with-references work and any future graph-based features.
- A benchmark suite covering full builds, incremental updates, and queries across realistic project sizes. Useful for any optimization work in either language.
- Path interning as a documented pattern. If Rust didn't have it before, it should after this experiment — interning is a win regardless of language.

## References

- `docs/3.3-algorithm-memo.md` — predecessor experiment context
- `src-tauri/src/link_graph.rs` (or equivalent) — current Rust implementation
- `docs/zig-diff-results.md` and `docs/zig-lint-results.md` — predecessor experiment writeups
- `docs/ledger-criteria.md` — the parallel substrate-question artifact

## Decision rule

This is the experiment whose result most directly informs the framework decision. Treat the writeup with proportional care.

If Zig graduates, the substrate intuition has three independent data points. The framework decision moves out of "should I" and into "how do I sequence the rebuild." That decision still depends on the ledger.

If Zig instructively fails, the substrate intuition has been tested at its strongest point and didn't hold up. The framework rebuild's case is materially weaker than it looked at the start of the portfolio. Write up the implications honestly. The conviction was good; the answer was no.

If the result is ambiguous — Zig wins on some axes and loses on others — the writeup needs to be especially careful. Ambiguous results are the most likely to get rationalized in either direction. Resist that. Write what you actually found, recommend what the evidence actually supports, and accept that "the data is mixed" is a legitimate conclusion that points toward staying on Tauri rather than rebuilding on uncertain ground.

## Synthesis writeup

After this experiment, write `docs/zig-portfolio-results.md` as a single synthesis document drawing on all three experiments. The synthesis is what the framework decision actually consumes — not the individual experiment memos. It should include:

- Summary of each experiment's outcome
- What Zig delivered consistently across the three surfaces (speed? allocation? clarity? something else?)
- What didn't translate (if anything)
- Whether the FFI boundary cost stayed manageable as the surface grew
- Recommendation: continue the Zig experiments to a fourth surface, freeze the portfolio at three, retire the Zig libraries entirely, or commit to the framework rebuild

The synthesis is the artifact you read alongside the ledger when making the framework decision. Both must point in the same direction for the rebuild to be the right call.

## What this is not

- A migration plan
- A prerequisite for the framework rebuild
- A replacement for the ledger
- The final word on Zig

This is the third of three calibration experiments. Together with the diff core and lint engine results, it produces the evidence that informs the substrate question. The substrate question is decided separately, with the ledger as the other half of the input.