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
- **The incremental comparison is between encodings, not between engines.**
  §3b measures `.folio` against `.md` inside this index; it does not show that
  SQLite could not do the same given block-level rows.
- **The snapshot is machine-specific.** Postings are stored as native-endian
  machine words, which is what makes the load a copy rather than a parse. A
  snapshot moved between machines fails its check and is rebuilt.
