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

---

## Stage 1 — the injected seams (2026-08-29)

**Goal.** Put all durable I/O and all time behind interfaces before a single
line of log code exists. This is the stage that cannot be retrofitted: crash
injection at every byte offset is impossible against code that calls `std.fs`
directly, and threading a seam through a finished storage engine afterward is
the expensive version of this work.

**What landed.**

- `src/storage.zig` — a four-operation `Storage` vtable (`append`, `sync`,
  `readAll`, `size`) in the `std.mem.Allocator` idiom, a closed four-member
  error set, and `Fault` as a `union(FaultClass)` so the injection tag set
  cannot drift from the model.
- `src/real_storage.zig` — the on-disk backend, on `std.Io`, appending by
  positional write against a cursor it owns rather than the file's shared seek
  position. Opens without truncating: an existing log is the record of truth.
- `src/sim_storage.zig` — the in-memory backend. Models `committed` versus
  `pending` bytes across the fsync barrier and produces the post-crash byte
  image for a given fault.
- `src/clock.zig` — a one-method `Clock` seam with real and simulated
  implementations.

**Decision: a narrow bespoke seam, not `std.Io`.** Zig 0.16 already has an
injected I/O interface and `shell-zig/core` threads one, so standing on it was
the obvious move and it is the wrong one here, on three counts. The faults
that matter are byte-image properties of a log — truncate at N, tear a sector,
flip a bit, lose the unsynced tail — not syscall behaviors, so injecting at
`std.Io` granularity means reconstructing the byte image anyway. The engine
plan requires the hand-rolled log and the LMDB fallback to present the same
API upward, and `std.Io` cannot express "LMDB is underneath". And the
governing discipline is to shrink the dangerous surface until it can be
exhaustively tested; four operations can be, a general I/O interface cannot.
`RealStorage` is still implemented *on* `std.Io`, so the real path stays
idiomatic. Reversible if it proves wrong — nothing above the seam knows.

**Four of the five fault classes are implemented.** Truncation, torn sector,
bit flip, and lost unsynced tail are all pure transformations of a byte image,
so they cost little and arrive now. `corrupt_snapshot` returns
`error.NoSnapshot` — not a stub, a true statement about a storage that holds
only a log. It gets a real implementation when snapshots land in stage 2.

Two modelling choices worth recording, because they make the faults harder
than the obvious reading:

- **Lost pages read back as zeroes, not as a shorter file.** A reader then
  faces plausible-length garbage rather than a clean short read, which is the
  more adversarial case and the one a naive length-prefix reader gets wrong.
- **`lost_unsynced_tail` is a survivor mask, not a prefix.** Page-cache loss
  is page-granular and out of order, so the fault takes a bitmask over pending
  pages and the harness sweeps every subset. A prefix-only model would have
  quietly excused the reordering case.

**`std.time.milliTimestamp` is gone in 0.16** — wall time is an `std.Io`
capability now (`std.Io.Timestamp.now(io, .real)`). That is a small argument
in favor of the seam rather than against it: the standard library reached the
same conclusion about time that this lab reaches about storage.

**Verification.** `zig build test --summary all` reports 11/11 passing from a
cleared cache. The load-bearing test — a lost unsynced tail never costs a
synced byte, swept across every subset of the pending pages — was confirmed
non-vacuous by widening the loss window to include committed bytes, observing
the failure at the expected assertion, and restoring. Truncation is asserted
at every byte offset of the seeded log, which is the sweep shape stage 2's
record framing will inherit.

**Next.** Stage 2 — record framing, append and replay, and the harness that
hammers them. The payload stays opaque bytes there: the log does not need to
understand blocks to be proven correct, and the most dangerous code in the
project deserves the simplest possible fixtures.

---

## Stage 2 — the log, and the harness that hammers it (2026-08-29)

**Goal.** The durability gate. Record framing, append, replay, snapshot
validation and fallback — and every fault class in the model injected against
them. This is the stage that decides whether Path A survives.

**Result: the gate is green.** 25/25 tests pass from a cleared cache, across
roughly 800 replays of a deliberately awkward 80-byte log.

**What landed.**

- `src/log.zig` — the wire format `[len:u32][crc32:u32][type:u8][payload]`,
  little-endian throughout, plus `Log.append` and `replay`.
- `src/snapshot.zig` — snapshot framing
  (`[magic:8][log_offset:u64][len:u32][crc32:u32][payload]`), the
  `SnapshotStore` seam, and a simulated backing that can corrupt or truncate a
  stored snapshot.
- `src/recover.zig` — newest trustworthy snapshot, then the log tail after it.
- `src/log_test.zig` — the harness.

**The payload is opaque bytes**, as planned. The log does not need to
understand blocks to be proven correct, and the most dangerous code in the
project deserves the simplest fixtures. Block encoding lands on a log that is
already green.

**Three framing decisions.**

- **Record type 0 is invalid.** Tags start at 1, so a zeroed page is rejected
  for two independent reasons rather than one. The checksum was already
  sufficient; this is defense in depth aimed at exactly the shape fault class
  4 injects.
- **The checksum covers the length field.** Not because a damaged length would
  otherwise slip through — it would fail the limit check or redirect the
  reader to a span whose payload fails its own checksum — but because it makes
  the length verifiable before it is trusted, so damage is reported where it
  happened instead of one record later. Defense in depth and diagnosis, not a
  unique detector. (An earlier draft of this comment overstated it.)
- **A bounded maximum payload length.** A corrupted length must never become a
  huge allocation. The limit check runs before anything is sized from the
  field.

**`unknown_type` is unreachable from corruption.** Because the checksum covers
the tag, a valid-checksum record with an unrecognized type can only come from
a future writer. Stage 2 stops replay there. Skipping such a record instead —
its length is known, so skipping is possible — is the forward-compatible
behavior, and it is a versioning decision that belongs with the schema work
rather than here. Carried to stage 7.

**Snapshot validation is stronger than "it decodes."** A snapshot whose
recorded log offset runs past the log we actually have is internally
consistent, correctly checksummed, and still wrong. `recover` rejects it and
falls back. This is the case the fault model lists under class 5 that no
checksum will ever catch, and it has its own test.

**Only a simulated snapshot store landed.** The seam's job at this stage is to
make the corrupt-snapshot fault injectable and the fallback testable, and the
payload is opaque bytes until the arena exists. A real on-disk store arrives
with stage 3, when there is something real to write. Stated as scope, not
discovered later.

**The sweeps, all exhaustive.** Sampling is a weaker claim to make when the
exhaustive one is affordable, and at this log size it is:

- truncation at all 81 byte offsets;
- every single-bit flip at every byte — 640 cases — each asserted to be caught
  at or before its own record;
- every 8-byte sector zeroed in turn;
- every subset of the pending pages after a mid-log sync;
- every byte of the newer snapshot corrupted in turn, each asserted to fall
  back to the prior known-good one at the correct log position;
- every truncation length of a snapshot.

The invariant behind all of them is stated once in the harness: **replay never
returns a record that differs from what was appended, and never returns a
partial one.** A crash may cost unconfirmed records; it may never invent or
damage a confirmed one.

**Verification.** Two mutations confirmed the harness is load-bearing rather
than decorative. Disabling the checksum comparison failed exactly four tests —
zeroed page, torn sector, bit flip, lost unsynced tail — which is the precise
set that depends on corruption detection. Disabling the snapshot log-position
bounds check failed exactly the test written for it. Both restored, clean
cache re-run green.

**Next.** Stage 3 — the arena and the block encoding. `PutBlock` payloads stop
being opaque and become encoded `.folio` blocks, conformance-checked against
the published schema through the existing parity-harness pattern.
