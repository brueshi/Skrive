import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeDiff, computeLineDiff } from "..";

const FIXTURES = resolve(__dirname, "..", "..", "..", "docs", "fixtures", "3.3");

function loadFixture(name: string): { before: string; after: string } {
  const before = readFileSync(resolve(FIXTURES, `${name}-before.md`), "utf8");
  const after = readFileSync(resolve(FIXTURES, `${name}-after.md`), "utf8");
  return { before, after };
}

type DiffOp = { kind: string; [k: string]: unknown };

function counts(ops: DiffOp[]) {
  const out = { kept: 0, added: 0, deleted: 0, moved: 0, reworded: 0 } as Record<
    string,
    number
  >;
  for (const op of ops) out[op.kind]++;
  return out;
}

// The Rust unit-test transcripts in `diff.rs::structural_tests` are the
// canonical oracle. These assertions mirror them exactly so a napi
// regression flips both surfaces in lockstep.

describe("compute_diff fixture parity", () => {
  it("reword fixture produces one reworded op (5 kept + 1 reworded)", () => {
    const { before, after } = loadFixture("reword");
    const ops = computeDiff(before, after) as DiffOp[];
    expect(counts(ops)).toEqual({
      kept: 5,
      added: 0,
      deleted: 0,
      moved: 0,
      reworded: 1,
    });
  });

  it("reword fixture word_diff is non-trivial", () => {
    const { before, after } = loadFixture("reword");
    const ops = computeDiff(before, after) as DiffOp[];
    const reworded = ops.find((op) => op.kind === "reworded") as
      | (DiffOp & { wordDiff: { kind: string; text: string }[] })
      | undefined;
    expect(reworded, "expected one reworded op").toBeDefined();
    expect(reworded!.wordDiff.some((w) => w.kind === "added")).toBe(true);
    expect(reworded!.wordDiff.some((w) => w.kind === "deleted")).toBe(true);
  });

  it("reorder fixture surfaces moves (5 kept + 6 moved)", () => {
    const { before, after } = loadFixture("reorder");
    const ops = computeDiff(before, after) as DiffOp[];
    expect(counts(ops)).toEqual({
      kept: 5,
      added: 0,
      deleted: 0,
      moved: 6,
      reworded: 0,
    });
  });

  it("insert fixture surfaces added section (7 kept + 3 moved + 3 added)", () => {
    const { before, after } = loadFixture("insert");
    const ops = computeDiff(before, after) as DiffOp[];
    expect(counts(ops)).toEqual({
      kept: 7,
      added: 3,
      deleted: 0,
      moved: 3,
      reworded: 0,
    });
  });

  it("empty inputs yield no ops", () => {
    expect(computeDiff("", "")).toEqual([]);
  });

  it("identical inputs yield only kept ops", () => {
    const src = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
    const ops = computeDiff(src, src) as DiffOp[];
    expect(ops.every((op) => op.kind === "kept")).toBe(true);
    expect(ops.length).toBe(3);
  });

  it("emits camelCase fields on structural ops", () => {
    const ops = computeDiff("a\n\nb\n", "a\n\nb\n") as DiffOp[];
    for (const op of ops) {
      expect(op).not.toHaveProperty("before_index");
      expect(op).not.toHaveProperty("after_index");
    }
    const kept = ops[0] as DiffOp;
    expect(kept).toHaveProperty("beforeIndex");
    expect(kept).toHaveProperty("afterIndex");
  });
});

describe("compute_line_diff", () => {
  it("identical strings produce only kept rows", () => {
    const rows = computeLineDiff("a\nb\nc\n", "a\nb\nc\n") as {
      kind: string;
      before: string | null;
      after: string | null;
    }[];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.kind).toBe("kept");
      expect(row.before).toBe(row.after);
    }
  });

  it("pure insertion produces added rows only", () => {
    const rows = computeLineDiff("", "x\ny\n") as {
      kind: string;
      before: string | null;
      after: string | null;
    }[];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.kind).toBe("added");
      expect(row.before).toBeNull();
      expect(row.after).not.toBeNull();
    }
  });

  it("replacement emits delete then insert", () => {
    const rows = computeLineDiff("A\nB\nC\n", "A\nX\nC\n") as {
      kind: string;
      before: string | null;
      after: string | null;
    }[];
    expect(rows.map((r) => r.kind)).toEqual(["kept", "deleted", "added", "kept"]);
  });
});
