#!/usr/bin/env python3
"""The SQLite arms of the known-item evaluation.

Same queries, same text, same ground truth — and **two** SQLite schemas,
because the choice of schema is most of the result and picking only one would
be picking the answer.

  * **block rows** mirrors our index exactly: one row per block. Its AND is
    therefore per block, so a query drawn from terms scattered across a
    document matches nothing. That is not FTS5 ranking badly; it is the schema
    being wrong for the question.

  * **document rows** is what a competent SQLite fallback would actually
    build for document-level search: one row per document, all its text. AND
    now spans the document, as ours does.

Reporting only the first would flatter us with a handicap we chose.

Run:  python3 bench/eval_sqlite.py --blocks blocks.tsv --cases cases.json
"""

import argparse
import json
import sqlite3

DEPTH = 20


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", required=True)
    ap.add_argument("--cases", required=True)
    args = ap.parse_args()

    rows = []
    with open(args.blocks, encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t", 3)
            if len(parts) == 4:
                rows.append((int(parts[0]), parts[1], parts[2], parts[3]))

    cases = json.load(open(args.cases, encoding="utf-8"))

    con = sqlite3.connect(":memory:")
    con.execute(
        "CREATE VIRTUAL TABLE blocks USING fts5(doc UNINDEXED, kind UNINDEXED, body)"
    )
    con.executemany("INSERT INTO blocks(rowid, doc, kind, body) VALUES (?, ?, ?, ?)", rows)

    # One row per document, holding everything that document contains.
    docs = {}
    for _, doc, _, body in rows:
        docs.setdefault(doc, []).append(body)
    doc_list = sorted(docs)
    con.execute("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, body)")
    con.executemany(
        "INSERT INTO docs(rowid, path, body) VALUES (?, ?, ?)",
        ((i, p, " ".join(docs[p])) for i, p in enumerate(doc_list)),
    )
    con.commit()

    def rank_blocks(terms, target):
        try:
            found = con.execute(
                "SELECT doc, bm25(blocks) AS s FROM blocks WHERE blocks MATCH ? ORDER BY s",
                (terms,),
            ).fetchall()
        except sqlite3.OperationalError:
            return 0
        best, order = {}, []
        for doc, score in found:
            if doc not in best:
                best[doc] = score
                order.append(doc)
        ranked = sorted(order, key=lambda d: best[d])[:DEPTH]
        return ranked.index(target) + 1 if target in ranked else 0

    def rank_docs(terms, target):
        try:
            found = con.execute(
                "SELECT path FROM docs WHERE docs MATCH ? ORDER BY bm25(docs)", (terms,)
            ).fetchall()
        except sqlite3.OperationalError:
            return 0
        ranked = [p for (p,) in found][:DEPTH]
        return ranked.index(target) + 1 if target in ranked else 0

    arms = [
        ("ours (all signals)", lambda c: c["ours"]),
        ("FTS5, block rows", lambda c: rank_blocks(c["_terms"], c["target"])),
        ("FTS5, document rows", lambda c: rank_docs(c["_terms"], c["target"])),
    ]

    by_set = {}
    for case in cases:
        case["_terms"] = " AND ".join(
            '"%s"' % w.replace('"', '""') for w in case["query"].split()
        )
        bucket = by_set.setdefault(case["set"], {})
        for name, fn in arms:
            acc = bucket.setdefault(name, {"n": 0, "mrr": 0.0, "at1": 0, "at5": 0, "missed": 0})
            rank = fn(case)
            acc["n"] += 1
            if rank:
                acc["mrr"] += 1.0 / rank
                acc["at1"] += rank == 1
                acc["at5"] += rank <= 5
            else:
                acc["missed"] += 1

    print("## Known-item retrieval, three arms\n")
    for set_name, bucket in by_set.items():
        print("### %s queries\n" % set_name)
        print("| arm | MRR | found@1 | found@5 | missed |")
        print("|---|---|---|---|---|")
        for name, _ in arms:
            a = bucket[name]
            n = a["n"]
            print("| %s | %.4f | %d/%d | %d/%d | %d |"
                  % (name, a["mrr"] / n, a["at1"], n, a["at5"], n, a["missed"]))
        print()


if __name__ == "__main__":
    main()
