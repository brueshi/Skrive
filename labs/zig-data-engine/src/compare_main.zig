//! `zig build compare -- --dir ../../docs --queries q.txt`
//!
//! Produces the thing that actually answers the spike's open question: the
//! same queries, over real prose somebody wrote, ranked three ways — BM25
//! alone, BM25 plus the Skrive signals, and (via the SQLite arm consuming the
//! blocks this emits) FTS5's own `bm25()`.
//!
//! It prints results rather than asserting on them, because "is this ranking
//! better" is a judgement about meaning that no test can make. What the tool
//! guarantees is that the three rankings see identical text and identical
//! queries, so a difference is attributable to ranking and nothing else.

const std = @import("std");
const root = @import("root.zig");

const usage =
    \\usage: compare --dir DIR [--queries FILE] [--top N] [--emit-blocks FILE]
    \\
    \\  --dir           directory of .md to index, walked recursively
    \\  --queries       one query per line; defaults to a built-in set
    \\  --top           results per query (default 8)
    \\  --emit-blocks   write the indexed block text for the SQLite arm
    \\
;

/// Queries that exercise the signals rather than the retrieval: words this
/// repository's prose actually uses, in the shapes a writer types.
const default_queries = [_][]const u8{
    "durability",
    "block identity",
    "search ranking",
    "snapshot",
    "cold start",
    "fault injection",
    "corpus",
    "the plan",
};

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const arena = init.arena.allocator();

    var dir_path: ?[]const u8 = null;
    var queries_path: ?[]const u8 = null;
    var emit_blocks: ?[]const u8 = null;
    var top: usize = 8;

    const args = try init.minimal.args.toSlice(arena);
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        i += 1;
        if (i >= args.len) return fail("missing value");
        if (std.mem.eql(u8, a, "--dir")) dir_path = args[i]
        else if (std.mem.eql(u8, a, "--queries")) queries_path = args[i]
        else if (std.mem.eql(u8, a, "--emit-blocks")) emit_blocks = args[i]
        else if (std.mem.eql(u8, a, "--top")) top = try std.fmt.parseInt(usize, args[i], 10)
        else {
            std.debug.print("{s}", .{usage});
            return fail("unknown argument");
        }
    }

    const root_dir = dir_path orelse {
        std.debug.print("{s}", .{usage});
        return fail("--dir is required");
    };

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    const stats = try root.loadVault(gpa, io, root_dir, &idx);
    idx.shrinkToFit();

    const now = std.Io.Timestamp.now(io, .real).toMilliseconds();

    std.debug.print(
        \\# Ranking comparison
        \\
        \\Corpus: `{s}` — {d} documents, {d} blocks, {d} terms, {Bi:.1} of prose.
        \\Links harvested {d}; documents with inbound links {d}.
        \\Index footprint {Bi:.1}. Each query shows the top {d}.
        \\
        \\
    , .{
        root_dir,          stats.documents, stats.blocks,
        idx.termCount(),   stats.bytes,
        stats.links,       countLinked(&idx),
        idx.footprint().total(), top,
    });

    var queries: std.ArrayList([]const u8) = .empty;
    if (queries_path) |path| {
        const bytes = try std.Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited);
        var lines = std.mem.splitScalar(u8, bytes, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t\r");
            if (trimmed.len != 0) try queries.append(arena, trimmed);
        }
    } else {
        for (default_queries) |q| try queries.append(arena, q);
    }

    for (queries.items) |text| {
        std.debug.print("## `{s}`\n\n", .{text});
        try report(gpa, io, &idx, text, "BM25 only", root.Weights.bm25_only, now, top);
        try report(gpa, io, &idx, text, "BM25 + Skrive signals", .{}, now, top);
        std.debug.print("\n", .{});
    }

    if (emit_blocks) |path| try emitBlocks(gpa, io, &idx, path);
}

fn countLinked(idx: *const root.Index) usize {
    var n: usize = 0;
    for (idx.docs.items) |d| {
        if (d.inbound != 0) n += 1;
    }
    return n;
}

fn report(
    gpa: std.mem.Allocator,
    io: std.Io,
    idx: *const root.Index,
    text: []const u8,
    label: []const u8,
    weights: root.Weights,
    now: i64,
    top: usize,
) !void {
    _ = io;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    // A trailing space so the last word is a complete term rather than a
    // prefix: these are finished queries, not search-as-you-type.
    const query = try root.parseQuery(a, try std.fmt.allocPrint(a, "{s} ", .{text}));
    const hits = try root.runQueryWith(idx, gpa, query, .{
        .weights = weights,
        .now_millis = now,
        .limit = top,
    });
    defer gpa.free(hits);

    std.debug.print("**{s}** — {d} shown\n\n", .{ label, hits.len });
    if (hits.len == 0) {
        std.debug.print("_no results_\n\n", .{});
        return;
    }

    for (hits, 1..) |hit, n| {
        const info = idx.blocks.items[hit.block];
        const doc = if (info.doc < idx.docs.items.len) idx.docs.items[info.doc] else root.DocInfo{
            .path = "?",
            .modified_millis = 0,
        };
        std.debug.print("{d}. `{s}` — {t}, score {d:.3} (base {d:.3}), {d} inbound\n", .{
            n, doc.path, info.kind, hit.score, hit.base, doc.inbound,
        });
    }
    std.debug.print("\n", .{});
}

/// The indexed text, for the SQLite arm, so both engines see the same units.
fn emitBlocks(
    gpa: std.mem.Allocator,
    io: std.Io,
    idx: *const root.Index,
    path: []const u8,
) !void {
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    for (idx.block_terms.items, 0..) |bt, ref| {
        if (!idx.block_live.items[ref]) continue;
        const info = idx.blocks.items[ref];
        const doc = if (info.doc < idx.docs.items.len) idx.docs.items[info.doc].path else "?";
        try out.print(gpa, "{d}\t{s}\t{t}\t", .{ ref, doc, info.kind });
        for (bt, 0..) |tp, k| {
            if (k != 0) try out.append(gpa, ' ');
            // Repeat a term as often as it occurs, so the arm sees the same
            // term frequencies this index recorded.
            var n: u32 = 0;
            while (n < tp.freq) : (n += 1) {
                if (n != 0) try out.append(gpa, ' ');
                try out.appendSlice(gpa, idx.terms.items[tp.term]);
            }
        }
        try out.append(gpa, '\n');
    }

    const file = try std.Io.Dir.cwd().createFile(io, path, .{});
    defer file.close(io);
    try file.writePositionalAll(io, out.items, 0);
}

fn fail(message: []const u8) error{BadUsage} {
    std.debug.print("compare: {s}\n", .{message});
    return error.BadUsage;
}
