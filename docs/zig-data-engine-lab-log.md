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

---

## Stage 3 — the arena and the block encoding (2026-08-29)

**Goal.** Stop `PutBlock` payloads being opaque bytes. Decode `.folio` into an
arena-allocated typed tree, write it back, and prove the bytes match what the
app writes — the check that keeps "one encoding, three consumers" true rather
than merely asserted.

**Result: green.** 34/34 tests. Every fixture parses and re-writes
byte-for-byte, including one the app itself produced.

**What landed.** `src/folio.zig` (the typed model), `src/folio_parse.zig` (a
tolerant reader), `src/folio_write.zig` (the canonical writer),
`src/folio_test.zig`, and a six-file fixture corpus with its provenance
recorded in `fixtures/README.md`.

**The decision that mattered: numbers are carried as their source token.**
The canonical form is `JSON.stringify(doc, null, 2) + "\n"`, so a file's
numbers were formatted by JavaScript. Reproducing those bytes from a parsed
`f64` would mean reimplementing ECMAScript number formatting in Zig and hoping
the two agree forever — a silent-drift machine of exactly the kind the "widen
together" rule exists to prevent. `std.json`'s `parse_numbers = false` yields
the verbatim token instead, so byte-identity is structural rather than a
coincidence, and the engine parses a number only where it wants one. This also
made the float problem below a non-issue rather than a research project.

**Two drifts found between the shipping code and the public spec.** Both
matter because the spec is the portability contract, not just documentation:

- **`table.widths` ships but is undocumented.** `app/src/lib/folio/types.ts:116`
  declares it and `serialize.ts:95` emits it; `docs/folio-schema-v1.md` §5
  never mentions it. A field that reaches real files is absent from the
  documented schema.
- **§9's "no floats in v1" is false.** `normalizeWidths`
  (`app/src/lib/blocksurface/table-chrome.ts:292`) rounds column weights to
  four decimal places, so floats are in `.folio` files today.

The lab implements the real behavior and the spec should be amended. Filed for
stage 7 rather than fixed mid-stage.

**Why the fixture corpus is what it is.** A self-consistent encoder
round-trips its own output forever while disagreeing with the app about
something small — whether `/` is escaped, say. Only a fixture the app wrote
catches that, so `app-written.folio` is a verbatim copy of the repository's
`testfolio.folio`. It arrived **already canonical**, which independently
confirms the canonical rule describes the real output format. The other five
fixtures cover what it does not: every block type, every inline kind, every
mark, links with and without titles, empty containers, ragged and empty
tables, fractional widths, preserved `docMeta` extras, and the full escape
range including control characters, CJK and emoji.

**Verification.** Beyond the green run, the writer was mutated to escape `/`
as `\/` — legal JSON that `JSON.stringify` never emits. The round-trip test
failed and the **idempotence test still passed**, which is the point in
miniature: self-consistency would have shipped the divergence, and only the
app-written fixture caught it.

**Next.** Stage 4 — a corpus at design scale. The largest fixture in the
repository is `docs/fixtures/perf-100` at 404K across 100 files, and there is
exactly one `.folio`; the plan's premise is tens of megabytes and tens of
thousands of blocks. Nothing can be measured honestly until that gap closes.

---

## Stage 4 — a corpus at design scale (2026-08-29)

**Goal.** Close the gap between what can be measured and what the plan argues
from. The repository's largest fixture is `docs/fixtures/perf-100` at 404K
across 100 files; the engine plan's premise is tens of megabytes and tens of
thousands of blocks.

**Result.** `zig build corpus` produces three tiers, reproducibly:

| tier | documents | blocks | words | distinct | `.folio` | `.md` |
|---|---|---|---|---|---|---|
| small | 20 | 372 | 22k | 2.4k | 398K | 143K |
| real | 100 | 2,026 | 125k | 14k | 2.4M | 904K |
| design | 2,000 | 39,872 | 2.45M | 113k | 47.7M | 18.5M |

**Written in Zig, in the lab, rather than extending
`scripts/build-perf-fixture.ts`.** The isolation invariant is the reason: a
lab that needs repository tooling to produce its own inputs is not
self-contained and does not graduate cleanly. The generator being Zig also
means the corpus is produced by the toolchain that consumes it, with no bun
in the loop.

**Every document is emitted twice**, `.folio` and `.md`, from one generated
block tree. That makes the encoding the only variable when the two index paths
are compared — `.folio` blocks carry stable ids and index incrementally, `.md`
blocks key on `(path, ordinal)` and re-index whole files.

**The vocabulary is Zipf-distributed, and that is the whole point.** Search
cost is dominated by postings-list length. Uniformly sampled words would give
every term a short postings list and make search look fast for a reason that
has nothing to do with the index. Words are also built from syllables rather
than random letters, so the vocabulary clusters by prefix the way a real one
does — which is what makes prefix queries, the search-as-you-type path,
behave realistically.

**Two realism corrections during the stage, both caught by looking at output
rather than by a test.** Tags were initially sampled from the Zipf
distribution and came out as `#the` and `#a`, which would have made
tag-filtered retrieval meaningless to measure; they now come from a bounded
pool of distinctive terms with reuse and nesting. And the vocabulary was a
fixed 5,000 words, which the design tier exhausted — with 2.4M tokens even
the rarest term landed seven times, leaving no terms that appear once, while
real text is 40-60% such terms.

**The vocabulary pools are deliberately larger than Heaps' law predicts.** The
design tier lands at roughly a 4.6% type-token ratio against real English
prose's ~1%, so its dictionary is several times larger than a natural corpus
of the same length. A fixed pool cannot reproduce both a realistic type-token
ratio and a realistic singleton tail, because real vocabulary is generative
rather than sampled. Given the choice, this errs toward the harder corpus:
dictionary and prefix search are tested against more terms than reality, not
fewer, which is the direction a gate should err.

**The distribution test was vacuous and the mutation check caught it.** It
tallied words by tokenizing the *serialized* form, so the top frequencies were
JSON keys — `kind` and `marks` appear once per inline node and swamp every
real word. Replacing Zipf with uniform sampling left it passing. It now walks
the block tree and counts only prose text, and the same mutation fails it.
Worth recording as the second time in this lab a test looked fine and proved
nothing until it was deliberately broken.

**Verification.** 39/39 from a cleared cache. On disk, two runs of the same
tier and seed are byte-identical, a different seed produces a different
corpus, and swapping the per-document arena provably does not change what is
generated. Every generated document survives the same parse-and-rewrite
round trip the conformance fixtures do, so the corpus is genuinely `.folio`
rather than something only this generator would accept.

**Next.** Stage 5 — the inverted index: interned token dictionary, postings
with positions, incremental patch on `PutBlock`, and prefix queries on the
trailing token. Prefix support is in scope from the start because it
determines the data structure, and retrofitting it is a rewrite rather than a
fix.

---

## Stage 5 — the inverted index (2026-08-29)

**Goal.** The index the whole engine argument rests on: interned dictionary,
postings, incremental maintenance, and prefix queries on the trailing token.

**Result.** 47/47. Conjunctive queries, prefix queries, block-kind ranking and
backlinks all work, and an incrementally updated index is byte-identical to a
freshly built one.

**What landed.** `src/tokenize.zig` (blocks to terms, with the block kind a
term came from), `src/index.zig` (dictionary, postings, block table,
backlinks), `src/search.zig` (query parsing and execution), and
`src/index_test.zig`.

**Postings carry a frequency, not positions.** The search plan wants match
offsets for snippet highlighting, and the obvious reading is to store every
position. That costs roughly a word of memory per word of corpus — around 10MB
at the design tier — to avoid re-scanning the ten blocks actually displayed,
which is microseconds. Offsets are recomputed from the matched block's own
text at display time instead. If phrase search later needs positions for
*intersection* rather than display, that is the moment to revisit; storing
them now would be paying for a feature that does not exist yet.

**The dictionary is prefix-searchable by construction**, because a hash map
cannot answer a prefix query and search-as-you-type makes every trailing token
one. Terms live in an array sorted by text, with newly interned terms held in
a small unsorted overlay merged when it fills. Two details matter:

- **The overlay cap is a fixed 1024, not a fraction of the dictionary.** The
  two costs pull opposite ways — every prefix query scans the whole overlay,
  so it must stay small, while every merge touches the whole sorted run, so
  merging must stay rare. A fraction would have let the overlay reach tens of
  thousands of terms at corpus scale and put that scan on every keystroke.
- **A merge merges two ordered runs; it does not re-sort the concatenation.**
  The first implementation re-sorted, which is O(n log n) of string
  comparisons per merge. At roughly a hundred merges over a hundred thousand
  terms that is the difference between imperceptible and seconds — and it
  would have surfaced at stage 6 as a bad number attributed to the wrong
  thing.

**The incremental update is a real diff.** A block's terms are kept sorted, and
an update merge-walks the old list against the new: terms only in the old are
removed, terms only in the new are inserted, and terms in both are touched
only when the frequency actually moved. Postings are kept sorted by block so
insert and remove are a binary search rather than a scan of a list that, for a
common term, is tens of thousands long.

**Mutation testing found two vacuous tests, again.**

- Removing the frequency-update branch of the diff — the subtlest line in the
  stage — **passed every test**. The fixture happened to keep every retained
  term at the same count across the edit, and the corpus-driven case put an
  empty draft first, so every term was a fresh insert. Both now exercise a
  retained term whose frequency moves, and the mutation fails both.
- Raising the overlay cap from 64 to 1024 silently made the merge test
  vacuous: its 900 terms no longer crossed the threshold, so no merge
  happened. It now uses 3,000 terms and asserts a merge counter rather than
  trusting a term count to cross a constant defined in another file — a test
  coupled to a tunable should assert the path, not the tuning.

Both halves of the prefix structure were then confirmed load-bearing by
disabling each in turn.

**Next.** Stage 6 — the two numbers. Cold-start replay and warm search
latency at design scale, per tier, with a SQLite FTS5 arm over the same corpus
and query set.

---

## Stage 6 — the two numbers, and the control arm (2026-08-29)

**Goal.** Produce the evidence SKR-139 exists for: cold-start replay and warm
search latency at design scale, in both encodings, against a SQLite FTS5 arm
over the same blocks and the same queries.

**Result.** Full numbers in `labs/zig-data-engine/docs/results.md`. 52/52
tests. The short version is three findings, and the third is the one that
matters most.

**The bespoke index is faster on every query shape** — 16x on single terms
(0.58 µs against 9.25 µs), 7.6x on conjunctions, and 2.5–4x on prefixes. On
what a writer actually types, a word or two words, it answers in single-digit
microseconds where SQLite takes tens.

**The tail is result-set size, and it belongs to neither arm.** A
one-character prefix matches 31,632 blocks, and both engines spend their time
materializing a result set nobody reads — an interface shows ten rows. The
6 ms median there is the cost of building a 31k-element answer, so the fix is
a top-k cutoff with early termination, not a faster index. Until that exists
neither arm meets the search plan's repaint-within-a-frame budget on short
prefixes; the bespoke arm misses by less, which is not the same as meeting it.

**SQLite reopens an existing index in 1.6 ms where the engine rebuilds in
667 ms.** This is the sharpest result of the spike and it is architectural
rather than incidental: the engine plan makes indexes derived and never
logged, so every start pays a full rebuild, while SQLite persists its index
and opens the file. A 400x gap on the cold path is not a tuning difference,
and it is the strongest argument the spike produced *against* the design as
written.

The phase breakdown says what to do about it. Of the 667 ms, index
construction is 306 ms, decode 206 ms, and read-and-replay 112 ms — and index
construction is 296 ms in the `.md` tier too, doing identical work. So the
cold path is dominated by rebuilding a structure the plan explicitly declines
to persist, and the lever is snapshotting the index, not compacting the log
payload. Which also settles stage 3's deferred question with a number: the
pretty-printed JSON payload costs about 100 ms at design scale, real but
smaller than the rebuild sitting next to it.

**The two encodings produced 39,872 blocks and term counts six apart** (90,316
against 90,322), which is the corpus doing its job — same content, two
encodings, encoding as the only variable. Search latency is indistinguishable
between them, as it must be, since they build the same index. Their whole
difference is on the cold path.

**What the numbers do not cover, stated in the results doc rather than left
implied.** The page cache is warm, so these are cold-process, warm-disk
figures. SQLite's *build* number is a floor and not a like comparison, since
it is handed pre-tokenized text; its *reopen* number is the honest one.
Neither arm was measured on ranking quality, which is not a latency question.
And nothing here measures incremental re-index — the property most specific to
this design, and invisible in a cold start that indexes every block once
either way.

**Stage additions.** `src/markdown_scan.zig`, a block-level scanner rather
than a parser, because the engine reads `.md` only to derive search and
backlinks and needs block boundaries, kinds and links — not a document model.
Its tests pin the 1:1 block correspondence between the two encodings, which is
what makes the two arms comparable in the first place.

**Next.** Stage 7 — the decisions, written down: Path A against Path B,
bespoke against SQLite, the two `.folio` spec drifts from stage 3, the
forward-compatibility question left by `unknown_type` in stage 2, and the
index-snapshot question this stage just raised.

---

## Stage 6b — the two missing measurements (2026-08-29)

Stage 6's numbers left the bespoke-versus-SQLite question unanswerable in both
directions: the cold-start deficit had a suspected fix nobody had tried, and
the property that most justifies building an index at all was untested. Both
measured now; `labs/zig-data-engine/docs/results.md` carries the full table.

**Persisting the index takes cold start from 687 ms to 18.5 ms.** A 37x
improvement, and it moves the number from a visible pause to below perception.
The snapshot is 34 MB, saves in 11 ms, and is verified byte-identical to the
rebuilt index before its load time is reported. It does not violate the rule
that indexes are derived and never logged — nothing enters the write-ahead
log, and a snapshot that fails validation is discarded and rebuilt.

**Getting there took three attempts and I was wrong twice**, which is worth
recording because both wrong answers were the plausible ones:

1. *Build the term dictionary's hash map lazily* — 90,000 inserts skipped on a
   read-only start. Saved nothing, and made exact-term queries 5x slower by
   pushing them onto a binary search. Reverted.
2. *Restore postings with one copy instead of reading two integers at a time*
   — roughly four million per-element reads eliminated. Moved the number 6%.
3. *Replace the snapshot's CRC32 with Wyhash.* A table-driven CRC32 runs at a
   few hundred megabytes a second, so checksumming a 34 MB body cost ~85 ms —
   more than everything else in the load put together. That was the whole
   cost.

The lesson is the ordinary one and I re-learned it the slow way: two rounds of
reasoning about where the time *should* be went to allocation and to loop
overhead, and splitting the measurement found it immediately in a checksum
nobody had thought about. The log keeps CRC32, where it guards durability over
records of a few hundred bytes; the snapshot only has to answer "trust this or
rebuild?", and a fast non-cryptographic hash answers that just as well.

**Re-indexing after an edit is 3.3 µs for a `.folio` block against 1,079 µs
for a whole `.md` file** — 328x, or 16x per block. This is the property stable
block ids exist to buy, invisible in a cold start that indexes every block
once, and it is the strongest measured argument for the block-identity design.
Stated precisely in the results doc: it compares two encodings *inside* this
engine, and does not show that SQLite could not do the same given block-level
rows and ids to key them on.

**Where the comparison now stands.** Search: bespoke faster on every shape,
15x on single terms. Cold start: 18.5 ms against SQLite's 1.6 ms, an order of
magnitude apart and both imperceptible, where before it was 400x and one of
them was not. Incremental update: measured, and strongly in favour of block
identity. The short-prefix tail remains a result-set-size problem belonging to
neither arm.

**Next.** Stage 7, with the evidence now actually sufficient to decide on.

---

## Stage 7 — the decisions (2026-08-29)

The spike's output. Record: `labs/zig-data-engine/docs/decisions.md`.

**Path A, and the hedge was never needed.** The fault harness is green under
every modelled fault; LMDB was not built. Reversible, since both substrates
present the same four-operation seam.

**The headline decision is more qualified than either side of the original
argument, and the qualification is the useful part.** The plan leans on search
being latency-bound and governs everything with "build bespoke only where the
user feels it." Measured, bespoke is 15x faster than SQLite FTS5 on a
single-term query — and 0.62 µs against 9.54 µs is a difference nobody can
perceive. Cold start is 18.5 ms against 1.6 ms; also imperceptible. **The
speed argument for a bespoke engine does not survive its own discipline.**

What survives: a durability surface small enough to have been exhaustively
fuzzed; block-level incremental re-index at 3.3 µs against 1,079 µs for the
containing `.md` file; and ranking control, which is §7's actual argument and
which this spike never measured. So the recommendation is to proceed *and to
build the ranking first rather than last*, since it is now the whole remaining
justification — with an adopted kill criterion if it does not deliver. That
call is the owner's and is marked as such in the record.

**Three things the spike added to B2's scope that were not in the plan:**
top-k with early termination (a one-character prefix matches 28,619 blocks and
neither arm meets the frame budget); index snapshots, with their
machine-specific layout and separate checksum; and forward-compatible replay,
where an unknown record type must be skipped rather than ending the log.

**Corrections applied to `docs/folio-schema-v1.md`**, which matters more than
the plan amendments because it is the public portability contract: `table.widths`
is now documented, §9's "no floats in v1" is corrected along with a note that
readers must round-trip a number's source token rather than re-deriving it from
a parsed float, and §7's "the engine stores nothing canonical" is narrowed —
re-scanning rebuilds every derived fact and restores identity, but no file scan
reconstructs history, because a file holds a document's present and not its past.

**SKR-292 filed** for the anchor-comment code that survived its own retirement:
`anchor.ts` is still imported by `parse.ts`, `serialize.ts` and `index.ts`, so
the app writes id comments into `.md` under a contract the plan removed. Two
incompatible identity schemes in the tree at once, and the B2 integration would
have hit it.

**SKR-61 updated** with the outcome, the reframing, the new scope and the kill
criterion. SKR-139 stays In Progress until the branch is merged, per the
repository's cadence.

**On the estimate.** "A few days" was right about the dangerous part —
skeleton, seams and durability gate were roughly that. It was wrong about how
much has to exist before the dangerous part can be measured against anything
real.

---

## Stage 8 — the footprint (2026-08-29)

The one claim the spike had measured nothing about, and the premise the whole
bespoke argument rests on: that a personal corpus fits in RAM comfortably on a
machine doing other things.

**It holds, with room.** At the design tier the index is **41.2 MB against
18.5 MB of prose** — about 2.2x — and the per-block cost *falls* with scale,
1,427 bytes at the small tier against 1,033 at the design tier, because the
dictionary amortizes as more blocks share terms.

**Peak process RSS is 124 MB, three times the steady-state index**, and that
is the number that matters for not disturbing someone's machine. The transient
is entirely the build: the whole 50 MB log is read in at once, the index
passes through a pre-shrink 52.7 MB, and the snapshot is materialized as a
single 34 MB buffer. None of those need to be resident together. Streaming the
replay and the snapshot write would cut most of it and neither is hard.

**Two findings from the breakdown.**

Reclaiming over-allocated capacity saved 22% for nothing. Postings lists grow
geometrically, so a bulk build had accumulated 11.5 MB of capacity nobody
asked for; handing it back once the build settles took 52.7 MB to 41.2 MB.
That is why the accounting reports slack apart from live bytes — one total
cannot tell an oversized design from an oversized allocation strategy.

The largest remaining structure is not the index. `block_terms` is 16 MB,
39% of the total, and exists solely so an update can diff a block's old terms
against its new ones. Once the block arena exists — plan §5.1, which this
spike never built — the arena holds each block's content, so the old term list
can be recovered by re-tokenizing the old block instead: microseconds per edit
in exchange for 39% of the index's memory. **That trade should be made when
the arena lands**, taking the design tier to roughly 25 MB, about 1.4x its
prose.

**Extrapolated**, five times this corpus lands the index near 200 MB and peak
build RSS past 500 MB unless the transients are streamed. That is where this
stops being a background citizen on a laptop, and it is close enough to design
for rather than discover.

**Method note.** Structures are counted exactly rather than sampled, so the
number attributes to a cause. Peak RSS comes from `getrusage`, whose `maxrss`
is bytes on Darwin and kilobytes on Linux — a real platform difference, not an
inconsistency to paper over.
