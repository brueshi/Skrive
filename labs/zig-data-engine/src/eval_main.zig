//! `zig build eval -- --dir ../../planning`
//!
//! Known-item retrieval, which is the honest way to score a ranking without
//! asking a human to judge every result.
//!
//! For each document the harness builds a query out of that document's own
//! most distinctive terms, then asks how far down the results the document
//! itself comes back. The ground truth is free and unarguable: the query was
//! made from this document, so this document is the right answer. It also
//! matches the dominant way people search their own notes — not "show me
//! everything about X" but "find the thing I know I wrote".
//!
//! Two query sets, kept separate because they test different claims:
//!
//!   * **content** — the highest tf-idf terms from the body, excluding the
//!     title. "I remember writing about these two things."
//!   * **title** — the document's name. "Find that document I named."
//!
//! Both engines index the same blocks, title blocks included, so neither is
//! handed a capability the other lacks.

const std = @import("std");
const root = @import("root.zig");

const Config = struct {
    name: []const u8,
    weights: root.Weights,
};

/// The ablation. Each row after the first two turns off exactly one signal,
/// so a metric that does not move says that signal is not earning its place.
const configs = [_]Config{
    .{ .name = "bm25_only", .weights = root.Weights.bm25_only },
    .{ .name = "all_signals", .weights = .{} },
    .{ .name = "no_block_kind", .weights = .{ .use_block_kind = false } },
    .{ .name = "no_heading", .weights = .{ .heading_proximity = 0 } },
    .{ .name = "no_recency", .weights = .{ .recency_weight = 0 } },
    .{ .name = "no_backlink", .weights = .{ .backlink_weight = 0 } },
    // Granularity, with every Skrive signal off, to isolate where the
    // evidence for a document actually lives.
    .{ .name = "blocks_only", .weights = blend(0.0) },
    .{ .name = "mixed_0.35", .weights = blend(0.35) },
    .{ .name = "mixed_0.65", .weights = blend(0.65) },
    .{ .name = "mixed_0.85", .weights = blend(0.85) },
    .{ .name = "documents_only", .weights = blend(1.0) },
};

fn blend(w: f32) root.Weights {
    var weights = root.Weights.bm25_only;
    weights.document_weight = w;
    return weights;
}

const depth = 20;

const Case = struct {
    set: []const u8,
    query: []const u8,
    target: root.DocRef,
    ranks: [configs.len]usize,
};

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const arena = init.arena.allocator();

    var dir_path: ?[]const u8 = null;
    var emit: ?[]const u8 = null;
    var emit_blocks: ?[]const u8 = null;
    var terms_per_query: usize = 3;

    const args = try init.minimal.args.toSlice(arena);
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        i += 1;
        if (i >= args.len) return fail("missing value");
        if (std.mem.eql(u8, a, "--dir")) dir_path = args[i]
        else if (std.mem.eql(u8, a, "--emit")) emit = args[i]
        else if (std.mem.eql(u8, a, "--emit-blocks")) emit_blocks = args[i]
        else if (std.mem.eql(u8, a, "--terms")) terms_per_query = try std.fmt.parseInt(usize, args[i], 10)
        else return fail("unknown argument");
    }
    const root_dir = dir_path orelse return fail("--dir is required");

    var idx = root.Index.init(gpa);
    defer idx.deinit();
    const stats = try root.loadVault(gpa, io, root_dir, &idx);
    idx.shrinkToFit();

    const now = std.Io.Timestamp.now(io, .real).toMilliseconds();

    var cases: std.ArrayList(Case) = .empty;
    defer cases.deinit(gpa);

    for (0..idx.docs.items.len) |doc_index| {
        const doc: root.DocRef = @intCast(doc_index);
        if (try buildQuery(arena, &idx, doc, terms_per_query, .content)) |q| {
            try cases.append(gpa, .{ .set = "content", .query = q, .target = doc, .ranks = undefined });
        }
        if (try buildQuery(arena, &idx, doc, terms_per_query, .title)) |q| {
            try cases.append(gpa, .{ .set = "title", .query = q, .target = doc, .ranks = undefined });
        }
    }

    for (cases.items) |*c| {
        for (configs, 0..) |cfg, ci| {
            c.ranks[ci] = try rankOf(gpa, &idx, c.query, c.target, cfg.weights, now);
        }
    }

    std.debug.print(
        \\# Known-item retrieval
        \\
        \\Corpus `{s}`: {d} documents, {d} blocks, {d} terms.
        \\{d} queries ({d} per document), each scored against depth {d}.
        \\
        \\
    , .{ root_dir, stats.documents, stats.blocks, idx.termCount(), cases.items.len, @as(usize, 2), depth });

    inline for (.{ "content", "title" }) |set| {
        std.debug.print("## {s} queries\n\n", .{set});
        std.debug.print("| configuration | MRR | found@1 | found@5 | missed |\n", .{});
        std.debug.print("|---|---|---|---|---|\n", .{});
        for (configs, 0..) |cfg, ci| {
            var mrr: f64 = 0;
            var at1: usize = 0;
            var at5: usize = 0;
            var missed: usize = 0;
            var n: usize = 0;
            for (cases.items) |c| {
                if (!std.mem.eql(u8, c.set, set)) continue;
                n += 1;
                const r = c.ranks[ci];
                if (r == 0) {
                    missed += 1;
                    continue;
                }
                mrr += 1.0 / @as(f64, @floatFromInt(r));
                if (r == 1) at1 += 1;
                if (r <= 5) at5 += 1;
            }
            const denom: f64 = @floatFromInt(@max(n, 1));
            std.debug.print("| `{s}` | {d:.4} | {d}/{d} | {d}/{d} | {d} |\n", .{
                cfg.name, mrr / denom, at1, n, at5, n, missed,
            });
        }
        std.debug.print("\n", .{});
    }

    if (emit) |path| try emitCases(gpa, io, &idx, cases.items, path);
    if (emit_blocks) |path| try emitBlocks(gpa, io, &idx, path);
}

/// The indexed blocks, for the SQLite arm. Both engines see the same units,
/// title blocks included, so neither is handed a capability the other lacks.
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
        for (bt) |tp| {
            var n: u32 = 0;
            while (n < tp.freq) : (n += 1) {
                try out.appendSlice(gpa, idx.terms.items[tp.term]);
                try out.append(gpa, ' ');
            }
        }
        try out.append(gpa, '\n');
    }

    const file = try std.Io.Dir.cwd().createFile(io, path, .{});
    defer file.close(io);
    try file.writePositionalAll(io, out.items, 0);
}

const QuerySet = enum { content, title };

/// The document's most distinctive terms: frequent here, rare elsewhere.
/// A term the document shares with everything identifies nothing.
fn buildQuery(
    arena: std.mem.Allocator,
    idx: *const root.Index,
    doc: root.DocRef,
    count: usize,
    set: QuerySet,
) !?[]const u8 {
    const Scored = struct { term: root.TermId, score: f64 };
    var scored: std.ArrayList(Scored) = .empty;
    defer scored.deinit(arena);

    const total: f64 = @floatFromInt(@max(idx.live_blocks, 1));

    for (idx.block_terms.items, 0..) |bt, ref| {
        if (!idx.block_live.items[ref]) continue;
        const info = idx.blocks.items[ref];
        if (info.doc != doc) continue;
        const is_title = info.kind == .title;
        if ((set == .title) != is_title) continue;

        for (bt) |tp| {
            const df: f64 = @floatFromInt(@max(idx.documentFrequency(tp.term), 1));
            const text = idx.terms.items[tp.term];
            // Very short tokens are mostly noise and numbering.
            if (text.len < 4) continue;
            try scored.append(arena, .{
                .term = tp.term,
                .score = @as(f64, @floatFromInt(tp.freq)) * @log(total / df),
            });
        }
    }
    if (scored.items.len == 0) return null;

    std.mem.sort(Scored, scored.items, {}, struct {
        fn call(_: void, a: Scored, b: Scored) bool {
            return a.score > b.score;
        }
    }.call);

    var out: std.ArrayList(u8) = .empty;
    var used: usize = 0;
    var seen: std.AutoHashMapUnmanaged(root.TermId, void) = .empty;
    defer seen.deinit(arena);

    for (scored.items) |s| {
        if (used == count) break;
        if (seen.contains(s.term)) continue;
        try seen.put(arena, s.term, {});
        if (used != 0) try out.append(arena, ' ');
        try out.appendSlice(arena, idx.terms.items[s.term]);
        used += 1;
    }
    if (used == 0) return null;
    return out.items;
}

/// Where the target document lands, or 0 if it is not in the top `depth`.
fn rankOf(
    gpa: std.mem.Allocator,
    idx: *const root.Index,
    text: []const u8,
    target: root.DocRef,
    weights: root.Weights,
    now: i64,
) !usize {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    const query = try root.parseQuery(a, try std.fmt.allocPrint(a, "{s} ", .{text}));
    const hits = try root.runDocuments(idx, gpa, query, .{
        .weights = weights,
        .now_millis = now,
        .limit = depth,
    });
    defer root.freeDocHits(gpa, hits);

    for (hits, 1..) |hit, n| {
        if (hit.doc == target) return n;
    }
    return 0;
}

fn emitCases(
    gpa: std.mem.Allocator,
    io: std.Io,
    idx: *const root.Index,
    cases: []const Case,
    path: []const u8,
) !void {
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    try out.appendSlice(gpa, "[\n");
    for (cases, 0..) |c, n| {
        if (n != 0) try out.appendSlice(gpa, ",\n");
        try out.print(gpa, "  {{\"set\": \"{s}\", \"query\": \"{s}\", \"target\": \"{s}\", \"ours\": {d}}}", .{
            c.set, c.query, idx.docs.items[c.target].path, c.ranks[1],
        });
    }
    try out.appendSlice(gpa, "\n]\n");

    const file = try std.Io.Dir.cwd().createFile(io, path, .{});
    defer file.close(io);
    try file.writePositionalAll(io, out.items, 0);
}

fn fail(message: []const u8) error{BadUsage} {
    std.debug.print("eval: {s}\n", .{message});
    return error.BadUsage;
}
