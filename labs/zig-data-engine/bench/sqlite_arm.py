#!/usr/bin/env python3
"""The control arm: SQLite FTS5 over the same blocks and the same queries.

Why this exists. SKR-139 decides two things, and the second — whether a
bespoke engine beats a vendored one on feel — is a comparison. Measuring only
the bespoke arm produces a number, not an answer: an absolute bar can be
cleared by an engine a generic layer would also have cleared, which passes the
gate while leaving the question open.

What is and is not a fair comparison here:

  * Search latency IS fair. Both arms answer identical queries over identical
    block text, in process, after a warm-up pass. This is the number the
    engine plan's revisit condition actually turns on.

  * Build time is NOT fair to the Zig arm. SQLite is handed pre-tokenized
    block text, so it never pays the JSON parse or Markdown scan that the Zig
    cold start includes. Its build number is therefore a floor, not a like
    comparison.

  * Reopen time is the honest cold-start comparison, and it favours SQLite by
    design rather than by accident: SQLite persists its index and reopens it,
    while the bespoke engine rebuilds its indexes from the log every start,
    because they are derived and never logged. That is an architectural
    difference the spike should surface, not smooth over.

Run:  python3 bench/sqlite_arm.py --blocks corpus/blocks.tsv \
          --queries corpus/queries.tsv --out corpus/sqlite.json
"""

import argparse
import json
import os
import sqlite3
import tempfile
import time


def percentile(sorted_us, p):
    if not sorted_us:
        return 0.0
    return sorted_us[(len(sorted_us) - 1) * p // 100]


def load_blocks(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t", 2)
            if len(parts) == 3:
                rows.append((int(parts[0]), parts[1], parts[2]))
    return rows


def load_queries(path):
    out = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line:
                continue
            kind, _, text = line.partition("\t")
            out.append((kind, text))
    return out


def match_expression(kind, text):
    """Translate a query into FTS5 syntax.

    Quoting every term matters: the generated vocabulary contains words that
    FTS5 would otherwise read as operators or bare-string edge cases, and an
    unquoted query would silently measure a different question.
    """
    if kind == "prefix":
        return '"%s"*' % text.replace('"', '""')
    words = ['"%s"' % w.replace('"', '""') for w in text.split()]
    return " AND ".join(words)


def shape_of(kind, text):
    if kind != "prefix":
        return "term" if kind == "term" else "conjunction"
    n = len(text)
    return "prefix_%dchar" % n if n <= 3 else "prefix_longer"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", required=True)
    ap.add_argument("--queries", required=True)
    ap.add_argument("--out")
    ap.add_argument("--repeats", type=int, default=25)
    args = ap.parse_args()

    blocks = load_blocks(args.blocks)
    queries = load_queries(args.queries)

    db_path = os.path.join(tempfile.mkdtemp(), "arm.db")

    build_start = time.perf_counter()
    con = sqlite3.connect(db_path)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE VIRTUAL TABLE blocks USING fts5(kind, body)")
    con.executemany(
        "INSERT INTO blocks(rowid, kind, body) VALUES (?, ?, ?)",
        ((ordinal, kind, body) for ordinal, kind, body in blocks),
    )
    con.commit()
    con.execute("INSERT INTO blocks(blocks) VALUES('optimize')")
    con.commit()
    build_ms = (time.perf_counter() - build_start) * 1000.0
    con.close()

    reopen_start = time.perf_counter()
    con = sqlite3.connect(db_path)
    con.execute("SELECT count(*) FROM blocks WHERE blocks MATCH ?", ("the",)).fetchone()
    reopen_ms = (time.perf_counter() - reopen_start) * 1000.0

    cur = con.cursor()
    sql = "SELECT rowid FROM blocks WHERE blocks MATCH ?"

    for kind, text in queries:
        cur.execute(sql, (match_expression(kind, text),)).fetchall()

    buckets = {}
    all_us = []
    for _ in range(args.repeats):
        for kind, text in queries:
            expression = match_expression(kind, text)
            start = time.perf_counter()
            rows = cur.execute(sql, (expression,)).fetchall()
            elapsed_us = (time.perf_counter() - start) * 1_000_000.0
            shape = shape_of(kind, text)
            bucket = buckets.setdefault(shape, {"us": [], "hits": 0})
            bucket["us"].append(elapsed_us)
            bucket["hits"] += len(rows)
            all_us.append(elapsed_us)

    all_us.sort()
    order = ["term", "conjunction", "prefix_1char", "prefix_2char", "prefix_3char", "prefix_longer"]
    by_shape = []
    for shape in order:
        bucket = buckets.get(shape)
        if not bucket:
            continue
        samples = sorted(bucket["us"])
        by_shape.append({
            "shape": shape,
            "runs": len(samples),
            "avg_hits": bucket["hits"] // len(samples),
            "p50_us": round(percentile(samples, 50), 3),
            "p99_us": round(percentile(samples, 99), 3),
            "max_us": round(percentile(samples, 100), 3),
        })

    report = {
        "arm": "sqlite-fts5",
        "sqlite_version": sqlite3.sqlite_version,
        "blocks": len(blocks),
        "build_ms": round(build_ms, 2),
        "reopen_ms": round(reopen_ms, 3),
        "queries": len(queries),
        "repeats": args.repeats,
        "overall": {
            "p50_us": round(percentile(all_us, 50), 3),
            "p90_us": round(percentile(all_us, 90), 3),
            "p99_us": round(percentile(all_us, 99), 3),
            "max_us": round(percentile(all_us, 100), 3),
        },
        "by_shape": by_shape,
    }

    text = json.dumps(report, indent=2)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")


if __name__ == "__main__":
    main()
