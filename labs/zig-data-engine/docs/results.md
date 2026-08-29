# Spike results

The two numbers SKR-139 exists to produce, plus the control arm that makes the
second of its decisions answerable.

**Measured 2026-08-29** on an Apple M1 Pro, macOS 26.6.2, Zig 0.16.0
(`ReleaseFast`), SQLite 3.51.0 via Python's `sqlite3`. Corpus: the `design`
tier, seed `0xc0ffee` — 2,000 documents, 39,872 blocks, 2.45M words, 113k
distinct terms, 47.7MB of `.folio` and 18.5MB of Markdown. Query set: 38
queries drawn from the corpus's own vocabulary across the whole frequency
range, 25 repetitions each, after an untimed warm-up pass.

Reproduce with:

```
zig build corpus -Doptimize=ReleaseFast -- --tier design --out corpus/design
zig build bench  -Doptimize=ReleaseFast -- --corpus corpus/design --tier folio \
    --emit-queries corpus/queries.tsv --emit-blocks corpus/blocks.tsv
zig build bench  -Doptimize=ReleaseFast -- --corpus corpus/design --tier md \
    --queries corpus/queries.tsv
python3 bench/sqlite_arm.py --blocks corpus/blocks.tsv --queries corpus/queries.tsv
```

## 1. Cold start to searchable

| | total |
|---|---|
| `.folio`, rebuilding the index from the log | 687 ms |
| `.md`, rebuilding the index from the files | 667 ms |
| **`.folio`, loading a persisted index** | **18.5 ms** |
| **`.md`, loading a persisted index** | **17.5 ms** |
| SQLite, rebuilding from scratch | 907 ms |
| SQLite, reopening an existing index | 1.6 ms |

Rebuild, by phase:

| | read + replay | decode | index |
|---|---|---|---|
| `.folio` | 112 ms | 206 ms | 326 ms |
| `.md` | — | 83 ms | 305 ms |

**Index construction dominates the rebuild and is encoding-independent** —
about 315 ms in both tiers, doing identical work. That is what made
persisting the index worth trying, and the pretty-printed JSON payload's
~120 ms decode penalty the smaller of the two levers. (That penalty is also
the number stage 3 deferred when it kept one human-readable serialization
rather than adding a compact second one for the log.)

**Persisting the index closes almost all of the gap: 687 ms becomes 18.5 ms**,
a 37x improvement that takes cold start from a visible pause to below
perception. The snapshot is 34 MB, saves in 11 ms, loads in 14 ms after a
4.6 ms read, and is verified byte-identical to the rebuilt index before its
time is reported. This does not violate the engine plan's rule that indexes
are derived and never logged: nothing here enters the write-ahead log, and a
snapshot that fails validation is discarded and rebuilt. It is a cache, and
it is treated as one.

Getting there took three attempts, and the two that failed are worth
recording because they were both plausible:

1. **Building the term dictionary's hash map lazily** — 90,000 inserts skipped
   on a read-only start. Saved nothing on load and made exact-term queries 5x
   slower, so it was reverted.
2. **Restoring postings with one copy instead of reading two integers at a
   time** — about four million per-element reads eliminated. Moved the number
   by 6%.
3. **Replacing the snapshot's CRC32 with Wyhash.** A table-driven CRC32 runs
   at a few hundred megabytes a second, so checksumming a 34 MB body cost
   ~85 ms — more than everything else in the load combined. This was the
   whole cost. The log keeps CRC32, where it guards durability over records of
   a few hundred bytes; the snapshot only needs to answer "is this intact
   enough to trust, or rebuild?", and a fast non-cryptographic hash answers it
   just as well.

Loading into an arena rather than a general allocator costs 11 ms against
14 ms, so roughly 3 ms of what remains is allocator overhead. The residual is
the 34 MB read and the copies themselves.

**What is left against SQLite is 18.5 ms versus 1.6 ms**, and the remaining
difference is architectural rather than a tuning gap: SQLite pages its index
in lazily from disk and does almost no work at open, while a RAM-resident
engine loads everything up front by design. An order of magnitude at this
scale is not a difference a person can perceive.

## 1b. Memory footprint

The plan's premise is that a personal corpus fits in RAM comfortably, and this
engine runs on someone's own machine beside everything else they have open.
Counted structure by structure rather than sampled, so the answer says which
part to attack.

| tier | blocks | prose | index | per block | peak process RSS |
|---|---|---|---|---|---|
| small | 372 | 0.14 MB | 0.5 MB | 1,427 B | 4.3 MB |
| real | 2,026 | 0.90 MB | 3.2 MB | 1,597 B | 12.3 MB |
| design | 39,872 | 18.5 MB | **41.2 MB** | 1,033 B | **124.2 MB** |

**The index costs about 2.2x the prose it indexes**, and the per-block cost
*falls* with scale — 1,427 bytes at the small tier against 1,033 at the design
tier — because the dictionary amortizes as more blocks share terms. The
premise holds at this size.

**Peak RSS is 3x the steady-state index**, and that is the number that matters
for not disturbing the machine. The transient is the build: the whole 50 MB
log is read into memory at once, the index passes through a pre-shrink 52.7 MB,
and the snapshot is materialized as a single 34 MB buffer. None of those need
to be resident simultaneously — streaming the log replay and the snapshot
write would cut most of it, and neither is hard.

Where the 41.2 MB goes:

| structure | | share |
|---|---|---|
| `block_terms` | 15.95 MB | 38.7% |
| postings | 15.95 MB | 38.7% |
| dictionary (hash, table, text, order) | 5.57 MB | 13.5% |
| postings list headers | 2.21 MB | 5.4% |
| block table | 1.11 MB | 2.7% |
| backlinks | 0.43 MB | 1.1% |

Two things stand out.

**Reclaiming over-allocated capacity saved 22% for free.** Postings lists grow
geometrically, so a bulk build left 11.5 MB of capacity nobody asked for —
52.7 MB became 41.2 MB by handing it back once the build settles. Slack is
reported separately from live bytes for exactly this reason: a single total
cannot distinguish an oversized design from an oversized allocation strategy.

**`block_terms` is the largest structure and it is not the index.** Those
16 MB — 39% of the total — exist solely so an update can diff a block's old
terms against its new ones. Once the block arena exists (plan §5.1, and the
spike never built it) the arena holds each block's content, so the old term
list can be recovered by re-tokenizing the old block: microseconds of work per
edit in exchange for 39% of the index's memory. **That trade should be made
when the arena lands**, and it would take the design tier to roughly 25 MB,
about 1.4x its prose.

**Extrapolating**, at five times this corpus — 10,000 documents, ~200,000
blocks, ~90 MB of prose — the index lands near 200 MB and peak build RSS
somewhere past 500 MB unless the transients are streamed. That is the point
where this stops being a background citizen on a laptop, and it is close
enough to be worth designing for rather than discovering.

## 2. Warm search latency

Median, with the p99 in the second table. Both arms answer identical queries
over identical block text, in process.

| shape | bespoke p50 | SQLite p50 | ratio | avg hits |
|---|---|---|---|---|
| single term | **0.62 µs** | 9.54 µs | 15.3x | 2,620 |
| conjunction | **2.79 µs** | 23.75 µs | 8.5x | 6 |
| 3-char prefix | **282 µs** | 1,950 µs | 6.9x | 12,065 |
| 2-char prefix | **2,489 µs** | 7,355 µs | 3.0x | 17,637 |
| 1-char prefix | **5,252 µs** | 27,349 µs | 5.2x | 28,619 |

| shape | bespoke p99 | SQLite p99 |
|---|---|---|
| single term | 1,703 µs | 5,663 µs |
| conjunction | 14 µs | 66 µs |
| 3-char prefix | 3,180 µs | 11,046 µs |
| 2-char prefix | 5,112 µs | 18,979 µs |
| 1-char prefix | 10,419 µs | 45,916 µs |

**The bespoke index is faster on every query shape**, by 15x on single terms
and 3–7x on prefixes. On the shapes a writer actually types — a word, or two
words — it answers in single-digit microseconds against SQLite's tens.

**But the tail is result-set size, not index structure, and it belongs to
neither arm.** A one-character prefix matches 31,632 blocks. Both engines
spend their time materializing a result set nobody will read: an interface
shows ten rows. The 6 ms median there is the cost of building a 31k-element
answer, and the fix is a top-k cutoff with early termination, not a faster
index. Until that exists, neither arm meets the search plan's
repaint-within-a-frame budget on short prefixes — the bespoke arm misses it by
less, which is not the same as meeting it.

## 3. The two encodings

`.folio` and `.md` produce **39,872 blocks and within six terms of each other**
(90,316 versus 90,322), which is the corpus doing its job: the same content in
two encodings, so the encoding is the only variable. Search latency is
indistinguishable between them, as it should be — they build the same index.

The difference is entirely on the cold path: `.folio` costs 210 ms more,
being 2.5x the bytes and a JSON parse rather than a line scan. The
incremental-re-index advantage that `.folio`'s stable block ids buy is **not
visible in these numbers at all**, because a cold start indexes every block
once either way. It would show up in a measurement this stage does not make:
the cost of re-indexing after a single block edit, where `.folio` touches one
block and `.md` re-indexes its whole file.

## 5. Ranking, against FTS5, on real prose

Measured 2026-08-29 on this repository's `planning/` directory — 74 documents,
4,031 blocks, 1.0MB of prose the owner wrote. Synthetic text cannot answer
this question: there is no sense in which one block of generated words is more
relevant than another, so relevance was invisible to every earlier
measurement.

Three rankings over identical blocks, identical term frequencies and identical
queries: our BM25 alone, our BM25 plus the Skrive signals, and SQLite FTS5's
`bm25()`. FTS5's `doc` and `kind` columns are UNINDEXED so both engines match
block body only — leaving them searchable let FTS5 match filename text our
index never sees, which is a difference in *what* is indexed rather than in
how it is ranked.

### The result

**On eight queries, the top document agreed every time.** An average of 3.2 of
5 documents overlapped. The Skrive signals reorder positions two through five;
they did not change the best answer on any query tested.

That is the honest answer to the question D2 asked, and it is not the one the
engine plan assumed. **Ranking order is not where this engine differentiates.**

### Where it does differ, and it is not ranking

- **Terms satisfied across a document.** `durability harness` returns four
  documents against FTS5's one, because FTS5's `AND` is per row and rows are
  blocks. Getting the same from FTS5 means indexing whole documents and losing
  block precision, or reimplementing the grouping above it.
- **Structural breadcrumbs.** Every result names the section it came from —
  "SKR-199 — export pipeline: `.folio` → Markdown / HTML / TXT / RTF". That
  comes from the block model and the heading relation; a generic index over
  block rows has nothing to build it from.
- **Grouped results.** One entry per document with its best blocks beneath it,
  rather than a flat list one long document can fill.

So the differentiator is the **shape of the result**, not the order. That is a
weaker claim than the plan made, and a real one.

### Two defects real prose found that synthetic text could not

- **Headings were weighted 4.0**, set when scoring was raw term frequency and a
  short heading needed the lift. BM25 already rewards brevity through length
  normalization, so the old weight double-counted: two-word headings scoring
  2.7 outranked substantive paragraphs scoring 8.7. Retuned to 1.5.
- **Document scoring ignored coverage.** A document whose best block answered
  half the query outranked one whose best block answered all of it, which put
  a heading called "Typographic identity" above the document actually about
  block identity for the query `block identity`. The document score is now
  weighted by its best block's coverage.

### A gap this comparison exposed

**Document titles and paths are not indexed.** A file named
`navigation-panels-plan.md` should rank for `navigation` and currently cannot,
because only block bodies are indexed. FTS5 got this for free while its `doc`
column was searchable, and the results were visibly better for it. This is
cheap to add and likely worth more than any weight tuning.

## 6. Known-item retrieval

Eight eyeballed queries cannot settle a ranking question. This is the
objective version: for each of 74 documents, build a query from that
document's own most distinctive terms and ask how far down the results the
document comes back. The ground truth is free and unarguable — the query was
made from this document, so this document is the answer. It is also the
dominant way people search their own notes: not "show me everything about X"
but "find the thing I know I wrote".

Two query sets. **content** uses the highest tf-idf terms from the body,
excluding the title. **title** uses the document's name. Every arm indexes the
same blocks, title blocks included.

### Where a document's evidence lives

Skrive signals all off, sweeping only the mix between scoring blocks and
scoring whole documents:

| mix | content MRR | content @1 | title MRR | title @1 |
|---|---|---|---|---|
| blocks only | 0.9268 | 64/74 | 0.9865 | 72/74 |
| 0.35 | 0.9369 | 65/74 | 0.9865 | 72/74 |
| **0.65** | **0.9797** | **71/74** | **0.9865** | **72/74** |
| 0.85 | 0.9865 | 72/74 | 0.9707 | 70/74 |
| documents only | 1.0000 | 74/74 | 0.7854 | 49/74 |

**Neither granularity wins both, and the failure modes are opposite.** A
document's evidence for a content query is spread across its blocks, so any
best-block-plus-tail aggregation throws most of it away — pure block scoring
finds the right document 64 times in 74 where pure document scoring finds it
every time. But a title is a short block of its own, and at document
granularity it dissolves into the body: pure document scoring drops to 49/74
on titles. Scoring at both granularities and mixing at 0.65 is within a point
of the best of either, on both sets. That is now the default.

### Against SQLite

| set | ours | FTS5, block rows | FTS5, document rows |
|---|---|---|---|
| content | 0.9797 | 0.2635 | **1.0000** |
| title | 0.9865 | 0.9865 | 0.7854 |

The FTS5 block-row column is reported and should be discounted: its `AND` is
per row, so a query drawn from terms scattered across a document matches
nothing and it misses 53 of 74. That is a schema chosen badly, not FTS5
ranking badly, and quoting it as a win would be quoting a handicap we picked.

Against the schema a competent fallback would actually build, **SQLite matches
or beats us on each set individually** — and, like us, no single SQLite schema
wins both. Getting both from SQLite means maintaining two tables and merging
them, which is the same architecture reached from the other direction.

### The ablation, and it is not what the plan assumed

Every Skrive signal, measured by removing it:

| set | all signals | no block kind | no heading | no recency | no backlink | none (BM25) |
|---|---|---|---|---|---|---|
| content | 0.9527 | 0.9662 | 0.9662 | 0.9595 | 0.9527 | **0.9797** |
| title | 0.9797 | 0.9459 | 0.9797 | 0.9797 | 0.9865 | **0.9865** |

**BM25 alone beats BM25 plus every Skrive signal, on both sets.** Removing any
single signal improves content retrieval or leaves it unchanged. Only
block-kind weighting earns its place anywhere, and only on titles, where
removing it costs 6 documents — and it costs content retrieval about as much
as it gains.

The honest reading: on the one search task with objective ground truth, the
Skrive-native signals cost roughly three points of MRR and gain nothing.

**The caveat, stated because it is real and not because it rescues the
result.** Known-item retrieval is exactly the task least able to show recency
and backlink weight in a good light: one document is correct, it usually has
overwhelming term evidence, and there is nothing to disambiguate. Those
signals are meant for the ambiguous case, where several documents are
plausible and the recent or well-referenced one is likelier to be wanted —
which needs a human judgement this harness cannot make. What can be said is
that they do not help here, and measurably hurt.

## 4. What this does not measure

- **Page cache is warm.** The corpus was just written, so these are
  "cold process, warm disk cache" figures — the optimistic end of a real cold
  start. A genuinely cold disk would measure the disk.
- **SQLite's build number is a floor, not a like comparison.** It is handed
  pre-tokenized block text and never pays the JSON parse or Markdown scan
  included in the engine's cold start. Its *reopen* number is the honest
  cold-start comparison, and it is the one that matters.
- **No ranking quality.** Both arms were timed on retrieval. Whether
  Skrive-native ranking is better than FTS5's is the argument in the engine
  plan's §7, and it is not a latency question.
- **Single-threaded, single-writer**, as the design specifies.
- **`vs_corpus_text` in the raw JSON compares against bytes read**, which for
  the `.folio` tier is the JSON, not the prose. The prose comparisons in §1b
  are computed against the Markdown tier's byte count.
- **The incremental comparison is between encodings, not between engines.**
  §3b measures `.folio` against `.md` inside this index; it does not show that
  SQLite could not do the same given block-level rows.
- **The snapshot is machine-specific.** Postings are stored as native-endian
  machine words, which is what makes the load a copy rather than a parse. A
  snapshot moved between machines fails its check and is rebuilt.
