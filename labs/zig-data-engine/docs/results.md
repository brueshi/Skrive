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

| | total | read + replay | decode | index |
|---|---|---|---|---|
| `.folio` (log replay) | **667 ms** | 112 ms | 206 ms | 306 ms |
| `.md` (file scan) | **456 ms** | — | 106 ms | 296 ms |
| SQLite, rebuild from scratch | 831 ms | — | — | — |
| **SQLite, reopen an existing index** | **1.6 ms** | — | — | — |

Three things fall out of that table.

**Index construction is the dominant cost and it is encoding-independent.**
Roughly 300 ms in both tiers, 46% of the `.folio` cold start and 65% of the
`.md` one, doing identical work. Anything that makes cold start materially
faster has to attack this number, not the format.

**The pretty-printed JSON payload costs about 100 ms.** `.folio` decode is
206 ms against Markdown's 106 ms for the same 39,872 blocks. That is the
measurement stage 3 deferred when it chose to keep one human-readable
serialization rather than add a compact second one for the log. It is a real
cost and a modest one — and it is smaller than the index rebuild it sits next
to, which is the more useful thing to know.

**SQLite reopens in 1.6 ms where the engine rebuilds in 667 ms.** This is the
sharpest result in the spike and it is architectural, not incidental: the
engine plan makes indexes derived and never logged, so every start pays a full
rebuild, while SQLite persists its index and simply opens the file. A 400x
difference on the cold path is not a tuning gap.

## 2. Warm search latency

Median, with the p99 in the second table. Both arms answer identical queries
over identical block text, in process.

| shape | bespoke p50 | SQLite p50 | ratio | avg hits |
|---|---|---|---|---|
| single term | **0.58 µs** | 9.25 µs | 15.8x | 2,620 |
| conjunction | **3.17 µs** | 24.08 µs | 7.6x | 5 |
| 3-char prefix | **720 µs** | 2,187 µs | 3.0x | 12,065 |
| 2-char prefix | **2,797 µs** | 7,076 µs | 2.5x | 21,874 |
| 1-char prefix | **6,128 µs** | 23,130 µs | 3.8x | 31,632 |

| shape | bespoke p99 | SQLite p99 |
|---|---|---|
| single term | 1,643 µs | 5,584 µs |
| conjunction | 8.7 µs | 65 µs |
| 3-char prefix | 3,298 µs | 11,660 µs |
| 2-char prefix | 4,536 µs | 18,510 µs |
| 1-char prefix | 9,913 µs | 45,117 µs |

**The bespoke index is faster on every query shape**, by 16x on single terms
and 2.5–4x on prefixes. On the shapes a writer actually types — a word, or two
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
- **No incremental-update measurement.** The property most specific to this
  design is untested here; see §3.
