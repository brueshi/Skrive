#!/usr/bin/env python3
"""The three-way ranking comparison, on real prose.

BM25 alone, BM25 plus the Skrive signals, and SQLite FTS5's own bm25() —
over identical blocks, identical term frequencies and identical queries, so a
difference between the columns is a difference in ranking and nothing else.

This is what the spike's D2 decision needs and never had. Latency said the
bespoke engine wins by margins nobody can perceive; the case for building it
rests on ranking, and ranking can only be judged on writing somebody
recognizes. Nothing here scores the rankings — a person reads the columns and
says which they would rather have been given.

Two fairness notes, both deliberate:

  * The block text is reconstructed from the index, with each term repeated as
    often as it occurred. That discards word order, which costs FTS5 nothing
    here because BM25 is a bag-of-words model on both sides, and it guarantees
    the two engines see identical term frequencies rather than two different
    tokenizers' opinions.

  * FTS5 ranks blocks; ours ranks documents. To compare like with like, FTS5's
    block scores are grouped by document and each document takes its best.
    That is the most generous reading of the FTS5 arm, not the least.

Run:  python3 bench/rank_compare.py --blocks blocks.tsv --rankings rankings.json
"""

import argparse
import json
import sqlite3


def load_blocks(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t", 3)
            if len(parts) == 4:
                rows.append((int(parts[0]), parts[1], parts[2], parts[3]))
    return rows


def fts5_ranking(con, query, top):
    """Documents by their best-scoring block. bm25() is negative, best first."""
    terms = " AND ".join('"%s"' % w.replace('"', '""') for w in query.split())
    rows = con.execute(
        "SELECT doc, bm25(blocks) AS score FROM blocks WHERE blocks MATCH ? ORDER BY score",
        (terms,),
    ).fetchall()

    best = {}
    for doc, score in rows:
        if doc not in best or score < best[doc]:
            best[doc] = score
    ordered = sorted(best.items(), key=lambda kv: kv[1])
    return [{"path": doc, "score": -score} for doc, score in ordered[:top]]


def column(entries, width):
    out = []
    for i in range(width):
        if i < len(entries):
            e = entries[i]
            out.append("%-44s %7.2f" % (e["path"][:44], e["score"]))
        else:
            out.append("")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", required=True)
    ap.add_argument("--rankings", required=True)
    ap.add_argument("--top", type=int, default=5)
    args = ap.parse_args()

    blocks = load_blocks(args.blocks)
    rankings = json.load(open(args.rankings, encoding="utf-8"))

    con = sqlite3.connect(":memory:")
    # doc and kind are UNINDEXED: they are metadata, and leaving them
    # searchable let FTS5 match on filename text that our index never sees,
    # which is a difference in what is indexed rather than in how it is
    # ranked. Both engines now match block body and nothing else.
    con.execute(
        "CREATE VIRTUAL TABLE blocks USING fts5(doc UNINDEXED, kind UNINDEXED, body)"
    )
    con.executemany(
        "INSERT INTO blocks(rowid, doc, kind, body) VALUES (?, ?, ?, ?)", blocks
    )
    con.commit()

    print("# Three-way ranking comparison\n")
    print("%d blocks indexed both ways. Each column lists documents, best first.\n"
          % len(blocks))

    agreement = []
    for entry in rankings["queries"]:
        query = entry["query"]
        ours_plain = entry["bm25_only"][: args.top]
        ours_full = entry["skrive"][: args.top]
        theirs = fts5_ranking(con, query, args.top)

        print("## `%s`\n" % query)
        print("| # | ours, BM25 only | ours, + Skrive signals | SQLite FTS5 |")
        print("|---|---|---|---|")
        for i in range(args.top):
            def cell(rows):
                if i >= len(rows):
                    return ""
                return "`%s`" % rows[i]["path"]
            print("| %d | %s | %s | %s |" % (i + 1, cell(ours_plain), cell(ours_full), cell(theirs)))

        if ours_full and theirs:
            same_top = ours_full[0]["path"] == theirs[0]["path"]
            overlap = len(
                {r["path"] for r in ours_full} & {r["path"] for r in theirs}
            )
            agreement.append((query, same_top, overlap, len(ours_full), len(theirs)))
            print("\nTop result %s. %d of %d documents in common.\n"
                  % ("agrees" if same_top else "**differs**", overlap, min(len(ours_full), len(theirs))))
        else:
            print("\n_one side returned nothing_\n")

        if ours_full:
            print("Section our top result points at: `%s`\n" % (ours_full[0]["section"] or "—"))

    if agreement:
        differs = [q for q, same, *_ in agreement if not same]
        print("## Summary\n")
        print("- Top result differs on %d of %d queries%s."
              % (len(differs), len(agreement),
                 (": " + ", ".join("`%s`" % q for q in differs)) if differs else ""))
        avg = sum(o for _, _, o, _, _ in agreement) / len(agreement)
        print("- %.1f documents in common on average, of %d shown." % (avg, args.top))


if __name__ == "__main__":
    main()
