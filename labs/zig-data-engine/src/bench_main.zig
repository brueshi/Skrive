//! `zig build bench -- --corpus corpus/design --tier folio --out results.json`
//!
//! The two numbers the spike exists to produce.
//!
//! **Cold start to searchable** means different work in the two tiers, and
//! that is correct rather than a flaw in the comparison. `.folio` is the
//! engine's own durable path: read the write-ahead log, replay it, decode
//! each block, index it. `.md` never enters the engine's write path at all —
//! the dual-mode rule keeps the serializer off it — so its cold start is read
//! the files, scan them into blocks, index. Both answer the same
//! user-facing question: from a cold process, how long until search works.
//!
//! **Warm search latency** is the same query set against both, run enough
//! times to have a p99 worth quoting.
//!
//! Caveat recorded here because it bounds every number below: the OS page
//! cache is warm across the cold-start measurement, since the corpus was just
//! written. These are therefore "cold process, warm disk cache" figures — the
//! optimistic end of a real cold start, and the right end for judging whether
//! the in-RAM design holds up, since a genuinely cold disk measures the disk.

const std = @import("std");
const root = @import("root.zig");
const markdown = @import("markdown_scan.zig");
const tokenize = @import("tokenize.zig");

const Query = struct {
    kind: enum { term, conj, prefix },
    text: []const u8,
};

const usage =
    \\usage: bench --corpus DIR --tier folio|md [--queries FILE] [--emit-queries FILE]
    \\              [--emit-blocks FILE] [--repeats N] [--out FILE]
    \\
;

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const arena = init.arena.allocator();

    var corpus_dir: ?[]const u8 = null;
    var tier: []const u8 = "folio";
    var queries_path: ?[]const u8 = null;
    var emit_queries: ?[]const u8 = null;
    var emit_blocks: ?[]const u8 = null;
    var out_path: ?[]const u8 = null;
    var repeats: usize = 25;

    const args = try init.minimal.args.toSlice(arena);
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        i += 1;
        if (i >= args.len) return fail("missing value");
        if (std.mem.eql(u8, a, "--corpus")) corpus_dir = args[i]
        else if (std.mem.eql(u8, a, "--tier")) tier = args[i]
        else if (std.mem.eql(u8, a, "--queries")) queries_path = args[i]
        else if (std.mem.eql(u8, a, "--emit-queries")) emit_queries = args[i]
        else if (std.mem.eql(u8, a, "--emit-blocks")) emit_blocks = args[i]
        else if (std.mem.eql(u8, a, "--out")) out_path = args[i]
        else if (std.mem.eql(u8, a, "--repeats")) repeats = try std.fmt.parseInt(usize, args[i], 10)
        else {
            std.debug.print("{s}", .{usage});
            return fail("unknown argument");
        }
    }

    const corpus_root = corpus_dir orelse {
        std.debug.print("{s}", .{usage});
        return fail("--corpus is required");
    };
    const is_folio = std.mem.eql(u8, tier, "folio");

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    var blocks_out: std.ArrayList(u8) = .empty;
    defer blocks_out.deinit(gpa);

    var build_ns: u64 = 0;
    var cold_ns: u64 = 0;
    // Cold start split by phase, because the fix differs completely
    // depending on where the time is: a slow decode argues for a compact log
    // payload, a slow index argues for snapshotting the index rather than
    // rebuilding it.
    var read_ns: u64 = 0;
    var decode_ns: u64 = 0;
    var index_ns: u64 = 0;
    var bytes_read: usize = 0;
    var block_count: usize = 0;

    if (is_folio) {
        // ---- build: corpus files into a durable log -----------------------
        const log_path = try std.fmt.allocPrint(arena, "{s}/engine.log", .{corpus_root});
        std.Io.Dir.cwd().deleteFile(io, log_path) catch {};

        const t_build = std.Io.Timestamp.now(io, .awake);
        {
            var storage = try root.RealStorage.open(io, std.Io.Dir.cwd(), log_path);
            defer storage.close();
            var log = root.Log.init(gpa, storage.storage());
            defer log.deinit();

            var dir = try std.Io.Dir.cwd().openDir(io, try std.fmt.allocPrint(arena, "{s}/folio", .{corpus_root}), .{ .iterate = true });
            defer dir.close(io);
            var it = dir.iterate();
            while (try it.next(io)) |entry| {
                if (entry.kind != .file) continue;
                const bytes = try dir.readFileAlloc(io, entry.name, gpa, .unlimited);
                defer gpa.free(bytes);
                bytes_read += bytes.len;

                var doc_arena = std.heap.ArenaAllocator.init(gpa);
                defer doc_arena.deinit();
                const doc = try root.parseFolio(doc_arena.allocator(), bytes);
                for (doc.blocks) |b| {
                    const encoded = try root.writeFolioBlock(doc_arena.allocator(), b);
                    try log.append(.put_block, encoded);
                }
            }
            try log.sync();
        }
        build_ns = elapsed(io, t_build);

        // ---- cold start: replay the log and index -------------------------
        const t_cold = std.Io.Timestamp.now(io, .awake);
        {
            const t_read = std.Io.Timestamp.now(io, .awake);
            var storage = try root.RealStorage.open(io, std.Io.Dir.cwd(), log_path);
            defer storage.close();
            const image = try storage.storage().readAll(gpa);
            defer gpa.free(image);

            var replayed = try root.replay(gpa, image);
            defer replayed.deinit(gpa);
            read_ns = elapsed(io, t_read);

            for (replayed.records, 0..) |record, ordinal| {
                var block_arena = std.heap.ArenaAllocator.init(gpa);
                defer block_arena.deinit();
                const ba = block_arena.allocator();

                const t_decode = std.Io.Timestamp.now(io, .awake);
                const block = try root.parseFolioBlock(ba, record.payload);
                const h = try root.harvest(ba, block);
                decode_ns += elapsed(io, t_decode);

                const kind: tokenize.BlockKind =
                    if (h.tokens.len == 0) .paragraph else h.tokens[0].kind;

                const t_index = std.Io.Timestamp.now(io, .awake);
                try idx.putBlock(@intCast(ordinal), .{ .doc = 0, .kind = kind }, h.tokens);
                for (h.links) |link| try idx.addBacklink(link.target, @intCast(ordinal));
                index_ns += elapsed(io, t_index);

                if (emit_blocks != null) try appendBlockRow(gpa, &blocks_out, ordinal, kind, h.tokens);
                block_count += 1;
            }
        }
        cold_ns = elapsed(io, t_cold);
    } else {
        // ---- cold start: scan the files and index -------------------------
        const t_cold = std.Io.Timestamp.now(io, .awake);
        var dir = try std.Io.Dir.cwd().openDir(io, try std.fmt.allocPrint(arena, "{s}/md", .{corpus_root}), .{ .iterate = true });
        defer dir.close(io);
        var it = dir.iterate();
        while (try it.next(io)) |entry| {
            if (entry.kind != .file) continue;
            const bytes = try dir.readFileAlloc(io, entry.name, gpa, .unlimited);
            defer gpa.free(bytes);
            bytes_read += bytes.len;

            var file_arena = std.heap.ArenaAllocator.init(gpa);
            defer file_arena.deinit();
            const fa = file_arena.allocator();

            // `.md` blocks have no stable id, so they are keyed by position:
            // the file's ordinal within the corpus scan plus the block's
            // ordinal within the file.
            const t_decode = std.Io.Timestamp.now(io, .awake);
            const scanned_blocks = try markdown.scan(fa, bytes);
            decode_ns += elapsed(io, t_decode);

            for (scanned_blocks) |scanned| {
                const t_harvest = std.Io.Timestamp.now(io, .awake);
                const h = try markdown.harvest(fa, scanned);
                decode_ns += elapsed(io, t_harvest);

                const t_index = std.Io.Timestamp.now(io, .awake);
                try idx.putBlock(@intCast(block_count), .{ .doc = 0, .kind = scanned.kind }, h.tokens);
                for (h.links) |link| try idx.addBacklink(link, @intCast(block_count));
                index_ns += elapsed(io, t_index);
                if (emit_blocks != null) try appendBlockRow(gpa, &blocks_out, block_count, scanned.kind, h.tokens);
                block_count += 1;
            }
        }
        cold_ns = elapsed(io, t_cold);
    }

    if (emit_blocks) |path| try writeOut(io, path, blocks_out.items);

    // ---- the query set ----------------------------------------------------
    var queries: []Query = undefined;
    if (queries_path) |path| {
        queries = try loadQueries(arena, io, path);
    } else {
        queries = try deriveQueries(arena, &idx);
    }
    if (emit_queries) |path| {
        var buf: std.ArrayList(u8) = .empty;
        defer buf.deinit(gpa);
        for (queries) |q| {
            try buf.appendSlice(gpa, @tagName(q.kind));
            try buf.append(gpa, '\t');
            try buf.appendSlice(gpa, q.text);
            try buf.append(gpa, '\n');
        }
        try writeOut(io, path, buf.items);
    }

    // ---- warm search ------------------------------------------------------
    //
    // Reported per query shape rather than as one blended distribution. A
    // single percentile over a mixed set hides which queries are slow, and
    // here they differ by three orders of magnitude: the tail is entirely
    // short prefixes, which expand to thousands of terms.
    const Bucket = struct {
        name: []const u8,
        samples: std.ArrayList(u64) = .empty,
        hits: usize = 0,
    };
    var buckets = [_]Bucket{
        .{ .name = "term" },
        .{ .name = "conjunction" },
        .{ .name = "prefix_1char" },
        .{ .name = "prefix_2char" },
        .{ .name = "prefix_3char" },
        .{ .name = "prefix_longer" },
    };
    defer for (&buckets) |*b| b.samples.deinit(gpa);

    // One untimed pass so the first query does not pay for cache warming
    // every other query avoids.
    for (queries) |q| _ = try runOne(&idx, gpa, q);

    var all: std.ArrayList(u64) = .empty;
    defer all.deinit(gpa);

    for (0..repeats) |_| {
        for (queries) |q| {
            const slot: usize = switch (q.kind) {
                .term => 0,
                .conj => 1,
                .prefix => switch (q.text.len) {
                    1 => 2,
                    2 => 3,
                    3 => 4,
                    else => 5,
                },
            };
            const t = std.Io.Timestamp.now(io, .awake);
            const hits = try runOne(&idx, gpa, q);
            const ns = elapsed(io, t);
            buckets[slot].hits += hits;
            try buckets[slot].samples.append(gpa, ns);
            try all.append(gpa, ns);
        }
    }

    for (&buckets) |*b| std.mem.sort(u64, b.samples.items, {}, std.sort.asc(u64));
    std.mem.sort(u64, all.items, {}, std.sort.asc(u64));

    var report: std.ArrayList(u8) = .empty;
    defer report.deinit(gpa);
    try report.print(gpa,
        \\{{
        \\  "tier": "{s}",
        \\  "blocks": {d},
        \\  "terms": {d},
        \\  "corpus_bytes": {d},
        \\  "build_ms": {d:.2},
        \\  "cold_start_ms": {d:.2},
        \\  "cold_start_phases_ms": {{ "read_and_replay": {d:.2}, "decode": {d:.2}, "index": {d:.2} }},
        \\  "queries": {d},
        \\  "repeats": {d},
        \\  "overall": {{ "p50_us": {d:.3}, "p90_us": {d:.3}, "p99_us": {d:.3}, "max_us": {d:.3} }},
        \\  "by_shape": [
        \\
    , .{
        tier,            block_count,
        idx.termCount(), bytes_read,
        ms(build_ns),    ms(cold_ns),
        ms(read_ns),     ms(decode_ns),  ms(index_ns),
        queries.len,     repeats,
        us(percentile(all.items, 50)), us(percentile(all.items, 90)),
        us(percentile(all.items, 99)), us(percentile(all.items, 100)),
    });

    var first = true;
    for (buckets) |b| {
        if (b.samples.items.len == 0) continue;
        if (!first) try report.appendSlice(gpa, ",\n");
        first = false;
        try report.print(gpa,
            \\    {{ "shape": "{s}", "runs": {d}, "avg_hits": {d}, "p50_us": {d:.3}, "p99_us": {d:.3}, "max_us": {d:.3} }}
        , .{
            b.name,
            b.samples.items.len,
            b.hits / b.samples.items.len,
            us(percentile(b.samples.items, 50)),
            us(percentile(b.samples.items, 99)),
            us(percentile(b.samples.items, 100)),
        });
    }
    try report.appendSlice(gpa, "\n  ]\n}\n");

    std.debug.print("{s}", .{report.items});
    if (out_path) |path| try writeOut(io, path, report.items);
}

fn runOne(idx: *const root.Index, gpa: std.mem.Allocator, q: Query) !usize {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    // A trailing separator means the word is finished; its absence means it is
    // still being typed and matches as a prefix.
    const text = switch (q.kind) {
        .prefix => try std.fmt.allocPrint(a, "{s}", .{q.text}),
        else => try std.fmt.allocPrint(a, "{s} ", .{q.text}),
    };
    const parsed = try root.parseQuery(a, text);
    const hits = try root.runQuery(idx, a, parsed);
    return hits.len;
}

/// A query set drawn from the corpus's own vocabulary, so every query hits
/// real terms with real postings rather than a synthetic best or worst case.
/// Terms are picked by postings-list length across the whole range, because a
/// set of only rare terms would flatter the index and a set of only common
/// ones would libel it.
fn deriveQueries(arena: std.mem.Allocator, idx: *const root.Index) ![]Query {
    const Ranked = struct { id: root.TermId, len: usize };
    var ranked: std.ArrayList(Ranked) = .empty;
    for (0..idx.termCount()) |id| {
        const n = idx.postingsFor(@intCast(id)).len;
        if (n != 0) try ranked.append(arena, .{ .id = @intCast(id), .len = n });
    }
    std.mem.sort(Ranked, ranked.items, {}, struct {
        fn call(_: void, a: Ranked, b: Ranked) bool {
            return a.len > b.len;
        }
    }.call);

    var out: std.ArrayList(Query) = .empty;
    const n = ranked.items.len;
    if (n == 0) return out.toOwnedSlice(arena);

    // Single terms spread across the frequency range.
    for (0..12) |k| {
        const at = (n - 1) * k / 11;
        try out.append(arena, .{ .kind = .term, .text = idx.terms.items[ranked.items[at].id] });
    }
    // Conjunctions pairing a common term with a rarer one, the usual shape of
    // a real query.
    for (0..8) |k| {
        const common = ranked.items[k % @min(n, 20)].id;
        const rarer = ranked.items[(n - 1) * (k + 1) / 9].id;
        if (common == rarer) continue;
        try out.append(arena, .{ .kind = .conj, .text = try std.fmt.allocPrint(
            arena,
            "{s} {s}",
            .{ idx.terms.items[common], idx.terms.items[rarer] },
        ) });
    }
    // Prefixes of one, two and three characters: the search-as-you-type path,
    // including the pathological single character.
    for ([_]usize{ 1, 2, 3 }) |width| {
        for (0..6) |k| {
            const at = (n - 1) * k / 5;
            const term = idx.terms.items[ranked.items[at].id];
            if (term.len < width) continue;
            try out.append(arena, .{ .kind = .prefix, .text = term[0..width] });
        }
    }
    return out.toOwnedSlice(arena);
}

fn loadQueries(arena: std.mem.Allocator, io: std.Io, path: []const u8) ![]Query {
    const bytes = try std.Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited);
    var out: std.ArrayList(Query) = .empty;
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        const tab = std.mem.indexOfScalar(u8, line, '\t') orelse continue;
        const kind = line[0..tab];
        const text = std.mem.trimEnd(u8, line[tab + 1 ..], "\r");
        try out.append(arena, .{
            .kind = if (std.mem.eql(u8, kind, "prefix")) .prefix
            else if (std.mem.eql(u8, kind, "conj")) .conj
            else .term,
            .text = text,
        });
    }
    return out.toOwnedSlice(arena);
}

fn appendBlockRow(
    gpa: std.mem.Allocator,
    out: *std.ArrayList(u8),
    ordinal: usize,
    kind: tokenize.BlockKind,
    tokens: []const tokenize.Token,
) !void {
    try out.print(gpa, "{d}\t{t}\t", .{ ordinal, kind });
    for (tokens, 0..) |t, k| {
        if (k != 0) try out.append(gpa, ' ');
        try out.appendSlice(gpa, t.text);
    }
    try out.append(gpa, '\n');
}

fn writeOut(io: std.Io, path: []const u8, bytes: []const u8) !void {
    const file = try std.Io.Dir.cwd().createFile(io, path, .{});
    defer file.close(io);
    try file.writePositionalAll(io, bytes, 0);
}

fn elapsed(io: std.Io, from: std.Io.Timestamp) u64 {
    const now = std.Io.Timestamp.now(io, .awake);
    const d = from.durationTo(now);
    return @intCast(@max(d.nanoseconds, 0));
}

fn ms(ns: u64) f64 {
    return @as(f64, @floatFromInt(ns)) / 1_000_000.0;
}

fn us(ns: u64) f64 {
    return @as(f64, @floatFromInt(ns)) / 1_000.0;
}

fn percentile(sorted: []const u64, p: usize) u64 {
    if (sorted.len == 0) return 0;
    const at = (sorted.len - 1) * p / 100;
    return sorted[at];
}

fn fail(message: []const u8) error{BadUsage} {
    std.debug.print("bench: {s}\n", .{message});
    return error.BadUsage;
}
