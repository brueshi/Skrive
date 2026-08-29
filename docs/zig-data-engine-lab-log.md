# zig-data-engine lab — session log

Running log for the B2 spike lab (SKR-139). The staged plan lives in
`planning/skr-139-spike-plan.md` (disk-only); the lab's own technical specs
live under `labs/zig-data-engine/docs/`.

---

## Stage 0 — lab skeleton and the fault model (2026-08-29)

**Goal.** Stand the lab up under the isolation invariant and write the fault
model down before any engine code exists.

**What landed.**

- `labs/zig-data-engine/` on the Zig 0.16.0 pin, matching `shell-zig/core`.
  No dependencies, no C, no linked system libraries. `zig build test` is green
  from a clean cache.
- `labs/zig-data-engine/docs/fault-model.md` — the five fault classes
  (truncation, torn sector, bit flip, lost unsynced tail, corrupt snapshot),
  each with its recovery contract and injection strategy, plus an explicit
  "what is not modeled" section.
- `labs/zig-data-engine/src/fault.zig` — the same model as a typed enum, so
  the simulated storage layer can switch exhaustively over it. Adding a class
  becomes a compile error until every injection site handles it. That is the
  property that stops "green under injected faults" from quietly narrowing as
  the engine grows.

**Decision recorded: the gate asserts non-loss, not availability.** Two
documents disagreed and the fault model could not be written until it was
settled. `docs/folio-schema-v1.md` §7 says the engine "stores nothing
canonical — deleting the engine's data and re-scanning the `.folio` files
reconstructs every managed fact"; `planning/local-data-engine-plan.md` §2.1
says store loss costs history and stable identity. Both cannot hold, because
per-block history is store-only and no file re-scan reconstructs it. Taken:
the engine plan is correct, the schema sentence is overreach written before
history was in view, and the harness asserts non-loss. `folio-schema-v1.md`
should be amended at Stage 7 rather than mid-spike.

**Why the fault model is code as well as prose.** The prose alone would let the
harness drift: a class could be described and never injected, and nothing would
say so. The exhaustive switch makes the compiler the enforcer. The cost is
keeping two artifacts in step, which is cheap while the list is five long and
is why the list is deliberately closed rather than open-ended.

**Isolation invariant verified.** Zero references to the lab from `app/`,
`shared/`, `shell-zig/`, `scripts/`, `harness/`, or any build config.
`rm -rf labs/zig-data-engine` breaks no Skrive build.

**Verification.** `zig build test --summary all` reports 1/1 passing from a
cleared cache. The test was confirmed to be real rather than vacuous by
breaking the invariant it asserts (duplicating a fault description), observing
the failure, and restoring.

**Next.** Stage 1 — the injected seams. All I/O behind a `Storage` interface
with a real `std.fs` implementation and a deterministic fault-injecting
simulation, and the clock injected the same way. This is the stage that cannot
be retrofitted, so it precedes every line of log code.
