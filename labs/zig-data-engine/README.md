# zig-data-engine — durable log and in-RAM index research lab

An isolated lab that answers two questions with measurements rather than
argument, on behalf of Skrive's B2 engine work:

1. **Path A or Path B?** A hand-rolled append-only log plus snapshots, or
   standing on LMDB as a proven durable substrate.
2. **Does bespoke beat vendored SQLite on feel?** The warm-search-latency
   number is the evidence for the engine plan's revisit condition — and it is
   a comparison, so a SQLite FTS5 control arm is measured alongside.

It produces two numbers — cold-start replay time and warm search latency — and
one binary result: does the fault-injection harness go green.

## The isolation invariant

This lab is born under the invariant every `labs/` project holds
(`docs/lab-graduation-checklist.md`): a self-contained build, **zero inbound
dependencies from the app**, and `rm -rf labs/zig-data-engine` breaks no Skrive
build. Nothing in `app/`, `shared/`, or `shell-zig/` references it.

The lab shares Skrive's block encoding as a **schema and a test corpus, never
as code**: it reads `.folio` files and JSONL fixtures against the published
spec in `docs/folio-schema-v1.md`. This is the same data-coupling the existing
parity harness uses, and it is what lets one encoding serve three consumers
without the lab importing a line of TypeScript.

Unlike `zig-ui`, this lab is classified **load-bearing** — Skrive is expected to
consume it — so graduation needs a published-artifact seam (the app depends on
a pinned published version, never a path import), not extract-and-forget.

## Design constraints, fixed from the first commit

- **The log is truth; RAM is the cache.** Every index is a rebuildable
  derivation. A bug that corrupts an index degrades a feature; it never
  destroys data.
- **Single writer.** One thread owns the arena, the log, and the indexes. No
  locks on the hot data structures.
- **All I/O and all time are injected.** Engine code never calls `std.fs` or
  reads a clock directly. Determinism is not a testing style here — it is the
  precondition for injecting a crash at every byte offset, and it cannot be
  retrofitted through a finished storage engine.
- **Never on the keystroke path.** The unit of exchange is a block or a query,
  never a document and never a keystroke.

## Layout

- `src/fault.zig` — the fault model as a typed enum. The prose spec is
  `docs/fault-model.md`; the two are kept in step deliberately, because "green
  under injected faults" only means something against an enumerated list.
- `src/root.zig` — the lab's public surface.
- `src/tests.zig` — test aggregator, run headless.

## Build

Zig 0.16.0, matching the pin in `shell-zig/core`. From this directory:

```
zig build test    # unit tests, headless
```

## The corpus

The repository's largest fixture is 404K across 100 files; the engine plan
argues from tens of megabytes and tens of thousands of blocks. `zig build
corpus` generates the corpus that premise describes, seeded and clock-free so
the same arguments reproduce the same bytes:

```
zig build corpus -Doptimize=ReleaseFast -- --tier design --out corpus/design
```

Tiers are `small` (20 documents), `real` (100, matching the existing perf
fixture) and `design` (2,000 documents, ~40k blocks, 18MB of Markdown and
48MB of `.folio`). Every document is written in both encodings from one
generated block tree, so the encoding is the only variable when the two index
paths are compared. Output is gitignored.

The staged plan — decision record, stage ladder, exit criteria — lives in
`planning/skr-139-spike-plan.md` (disk-only, not committed). The running
session log is `docs/zig-data-engine-lab-log.md`.
