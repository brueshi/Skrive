# Spike decisions (SKR-139)

What the spike settled, what it failed to settle, and what it changed its mind
about. Evidence is `results.md`; the reasoning behind each stage is
`docs/zig-data-engine-lab-log.md` in the repository root.

One decision here is the owner's rather than mine and is marked as such.

---

## D1 — Path A: the hand-rolled append log. **Decided.**

The engine plan offered a hand-rolled log or standing on LMDB, to be chosen at
spike time, with the recommendation to try Path A behind the fault-injection
harness and keep LMDB as the hedge if durability bugs proved expensive to
close.

**Path A, and the hedge was not needed.** The harness is green under every
class in the fault model — truncation at all 81 byte offsets of the fixture
log, all 640 single-bit flips each caught at or before its own record, every
sector zeroed in turn, every subset of pending pages after a mid-log sync, and
every byte and truncation length of a snapshot. The framing and replay come to
roughly 170 lines.

LMDB was never built. The decision stays reversible: both substrates present
the same four-operation seam upward, so swapping one in touches nothing above
it.

---

## D2 — The bespoke engine proceeds, on narrower grounds than the plan
## assumed. **Recommended — the owner's call.**

This is the decision the spike exists for, and the honest answer is more
qualified than either side of the original argument.

**The speed argument does not survive contact with the numbers.** The plan
leans on search being latency-bound, and §10 governs everything with "build
bespoke only where the user feels it." Measured:

| | bespoke | SQLite FTS5 | felt? |
|---|---|---|---|
| single term | 0.62 µs | 9.54 µs | neither |
| conjunction | 2.79 µs | 23.75 µs | neither |
| cold start | 18.5 ms | 1.6 ms | neither |

The bespoke index is 15x faster on the query a writer actually types, and
**nobody can perceive the difference between 0.6 µs and 9.5 µs.** The same is
true in the other direction for cold start once the index is persisted. On
latency alone, a generic TS-plus-SQLite path is close to indistinguishable in
feel at design scale — which is very nearly the engine plan's §15 condition
for reopening the language boundary, not for clearing it.

**What does survive:**

1. **Durability at a surface small enough to have actually tested.** The
   dangerous code is a few hundred lines and is exhaustively fuzzed. That is
   the thing the plan said would make a custom engine reasonable rather than
   reckless, and it held.
2. **Block-level incremental re-index.** 3.3 µs to re-index an edited
   `.folio` block against 1,079 µs to re-index the `.md` file containing it.
   Structural, not tuning. The caveat in `results.md` stands — SQLite could
   match this given block-level rows and stable ids, which is the same
   architecture reached from the other direction — but it does confirm the
   block-identity design pays.
3. **Ranking control**, which is §7's actual argument and is **still
   unproven.** Nothing in this spike measured whether Skrive-native ranking
   (block kind, heading proximity, backlink weight, recency) produces better
   results than FTS5 given the same signals. It is a search-quality question,
   not a latency one.

**Recommendation: proceed, and prove the ranking claim early in B2 rather than
assuming it.** With the speed case gone, ranking is the whole remaining
justification for a bespoke index, so it should be the first thing built and
judged — not the last.

**Kill criterion to adopt with this decision:** if the ranking work in B2 does
not produce a search experience the owner judges materially better than FTS5
given the same signals, the bespoke *index* has no remaining justification and
SQLite is the honest fallback. The durable log (D1) is a separate question and
is not covered by this criterion — it earns its place on history, sync
replay, and `.folio` durability regardless of how search is served.

---

## D3 — The index is snapshotted, not rebuilt on every start. **Decided.**

New, and not in the plan. The plan makes indexes derived and never logged, and
that stays exactly true: nothing here enters the write-ahead log, and a
snapshot that fails validation is discarded and rebuilt from the log. What
changes is that the derived structure is *cached* to disk.

The reason is the measurement: rebuilding costs 687 ms, loading costs 18.5 ms.
Without this, cold start was 400x worse than SQLite's reopen and visibly slow;
with it, the gap is an order of magnitude and both are imperceptible.

Two consequences to carry into B2:

- **The snapshot is machine-specific.** Postings are stored as native-endian
  machine words, which is what makes loading a copy rather than a parse. A
  snapshot moved between machines fails its check and is rebuilt. Acceptable
  for a cache; it must never become the way anything is transported.
- **The snapshot's checksum is Wyhash, not the log's CRC32**, because a
  table-driven CRC32 over a 34 MB body cost more than the entire rest of the
  load. The two checksums answer different questions and should stay
  different: the log's guards durability over small records, the snapshot's
  only decides whether to trust a cache or rebuild it.

---

## D4 — One block encoding, one serialization. **Decided; keeps the stage 3
## posture, now with a number behind it.**

The plan requires one encoding across the file body, the WAL payload and the
boundary. Stage 3 kept a single human-readable serialization and deferred the
question of whether the log needs a compact second form.

**Keep one.** The measured cost of pretty-printed JSON is about 120 ms of
decode at design scale, and it is paid only on a rebuild — that is, only when
there is no valid snapshot. Against that: a second serialization is a second
thing to keep in step, which is precisely the drift the "widen together" rule
exists to prevent, and it would cost the operational asset of a log a person
can read in a text editor.

Revisit only if rebuilds become common in practice rather than exceptional.

---

## D5 — An unknown record type should be skipped, not treated as the end of
## the log. **Recommended for B2.**

Stage 2 stops replay at a valid, correctly-checksummed record whose type this
version does not know. That is the safe behaviour for a spike and the wrong
one for a shipped format: because the checksum covers the type tag, such a
record can only come from a *newer writer*, never from corruption, and its
length is known — so it can be stepped over.

Stopping means an older build silently truncates a newer build's log at the
first unknown record. B2 should skip and carry on, and must never rewrite or
compact a log containing unknown records without preserving them verbatim.

---

## D6 — `.md` identity is `(path, ordinal)`; the anchor-comment code should be
## deleted. **Decided by the plan already; the code has not caught up.**

The dual-mode amendment retires the `<!-- sk:ID -->` mechanism and SKR-163 was
cancelled with it on 2026-07-10. But `app/src/lib/blockmodel/anchor.ts` is
still imported by `parse.ts:20`, `serialize.ts:63` and `index.ts:23`, so the
app still writes anchors into `.md` files for durable blocks.

Two identity schemes for `.md` cannot both be right. The spike keyed on
`(path, ordinal)` per the plan and never needed anchors. Filed as **SKR-292**
— it is live code implementing a retired decision, and it will confuse the B2
integration.

---

## D7 — Three corrections to `docs/folio-schema-v1.md`. **Decided.**

The schema doc is the public portability contract, so drift in it is a
different order of problem from drift in a plan.

1. **`table.widths` is emitted but undocumented.** `types.ts:116` declares it
   and `serialize.ts:95` writes it; §5 never mentions it.
2. **§9's "no floats in v1" is false.** `normalizeWidths`
   (`app/src/lib/blocksurface/table-chrome.ts:292`) rounds column weights to
   four decimal places, so floats are in `.folio` files today.
3. **§7's "the engine stores nothing canonical" is too strong.** It says
   re-scanning the files reconstructs every managed fact. Per-block history is
   store-only and no file scan reconstructs it — the engine plan §2.1 is
   correct, and this sentence was written before history was in view. It
   matters because it decides whether the durability gate is about
   availability or about data loss; the spike took the stricter reading.

Applied to the schema doc in this stage.

---

## D8 — Top-k with early termination is a B2 requirement, not polish.
## **Decided.**

A one-character prefix matches 28,619 blocks. Both arms spend milliseconds
materializing a result set nobody reads, and **neither meets the search plan's
repaint-within-a-frame budget on short prefixes.** The bespoke arm misses by
less, which is not the same as meeting it.

The fix is not a faster index — it is to stop building answers nobody asked
for. This belongs in SKR-61's scope now, because retrofitting early
termination into a query path that assumes full materialization is a rewrite
of the query path.

---

## What the spike did not settle

- **Ranking quality**, the actual justification for a bespoke index. See D2.
- **Multi-process access.** Single-writer throughout, as designed. Untested
  against a second window or helper process.
- **A genuinely cold disk.** Every number is cold-process, warm-page-cache.
- **fsync window, snapshot cadence, compaction policy.** Still the plan's
  open questions; the numbers here inform them but do not decide them.
- **iOS lifecycle flush.** Unchanged and still owed a design.

## On the estimate

The plan called the spike "a few days". Stages 0 through 2 — the skeleton,
the seams and the durability gate — were about that. The full ladder through
a design-scale corpus, an index, both arms and the two follow-up measurements
was substantially more. The estimate was not wrong about the dangerous part;
it was wrong about how much has to exist before the dangerous part can be
measured against anything real.
