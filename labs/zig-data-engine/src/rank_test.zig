//! Ranking signals.
//!
//! Whether the ranking is *good* is a semantic question that needs real prose
//! and a human, and nothing here attempts it. What these do is prove each
//! signal is wired and moves results in the direction it claims to — so that
//! when the side-by-side comparison runs on real content, a disappointing
//! result means the signal does not help rather than that it never fired.

const std = @import("std");
const root = @import("root.zig");
const rank = @import("rank.zig");

const Token = root.tokenize.Token;

fn tokens(gpa: std.mem.Allocator, text: []const u8, kind: root.BlockKind) ![]Token {
    var out: std.ArrayList(Token) = .empty;
    var it = std.mem.tokenizeScalar(u8, text, ' ');
    while (it.next()) |w| try out.append(gpa, .{ .text = w, .kind = kind });
    return out.toOwnedSlice(gpa);
}

fn put(idx: *root.Index, arena: std.mem.Allocator, ref: root.BlockRef, text: []const u8, kind: root.BlockKind) !void {
    try idx.putBlock(ref, .{ .doc = 0, .kind = kind }, try tokens(arena, text, kind));
}

fn topHits(idx: *const root.Index, gpa: std.mem.Allocator, text: []const u8, opts: root.SearchOptions) ![]root.Hit {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const query = try root.parseQuery(arena_state.allocator(), text);
    return root.runQueryWith(idx, gpa, query, opts);
}

// ---- the BM25 core --------------------------------------------------------

test "inverse document frequency falls as a term becomes common" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    // "common" in every block, "rare" in one.
    for (0..100) |i| {
        const text = if (i == 0) "common rare" else "common filler";
        try put(&idx, arena, @intCast(i), text, .paragraph);
    }

    const ctx = root.RankContext.init(&idx, .{}, 0);
    const common = idx.lookup("common").?;
    const rare = idx.lookup("rare").?;

    try std.testing.expect(ctx.idf(rare) > ctx.idf(common) * 5);
    // A term in every block carries almost no information and must not go
    // negative, which the naive form of this formula does.
    try std.testing.expect(ctx.idf(common) >= 0);
}

test "inverse document frequency decides which term's frequency matters" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    // Both candidates are the same length and hold the same six tokens in
    // different proportions, so term frequency and length normalization
    // cannot separate them. Only knowing that "rare" is rare can.
    try put(&idx, arena, 0, "common common common common common rare", .paragraph);
    try put(&idx, arena, 1, "common rare rare rare rare rare", .paragraph);
    for (2..200) |i| try put(&idx, arena, @intCast(i), "common filler", .paragraph);

    const hits = try topHits(&idx, gpa, "common rare ", .{ .weights = root.Weights.bm25_only });
    defer gpa.free(hits);

    try std.testing.expectEqual(@as(usize, 2), hits.len);
    try std.testing.expectEqual(@as(root.BlockRef, 1), hits[0].block);
    // And by a clear margin, not a rounding accident. Without weighting by
    // rarity these two score identically, which is the whole point.
    try std.testing.expect(hits[0].score > hits[1].score * 1.5);
}

test "a shorter block outranks a longer one for the same term" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    try put(&idx, arena, 0, "target padding padding padding padding padding padding", .paragraph);
    try put(&idx, arena, 1, "target", .paragraph);

    const hits = try topHits(&idx, gpa, "target ", .{ .weights = root.Weights.bm25_only });
    defer gpa.free(hits);

    try std.testing.expectEqual(@as(usize, 2), hits.len);
    try std.testing.expectEqual(@as(root.BlockRef, 1), hits[0].block);
}

test "term frequency saturates rather than counting linearly" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    try put(&idx, arena, 0, "target", .paragraph);
    try put(&idx, arena, 1, "target target target target target target target target target target", .paragraph);
    for (2..40) |i| try put(&idx, arena, @intCast(i), "filler", .paragraph);

    const ctx = root.RankContext.init(&idx, root.Weights.bm25_only, 0);
    const term = idx.lookup("target").?;
    const once = ctx.termScore(term, 0, 1);
    const ten = ctx.termScore(term, 1, 10);

    // More is better, but nothing like ten times better.
    try std.testing.expect(ten > once);
    try std.testing.expect(ten < once * 4);
}

// ---- the Skrive signals ---------------------------------------------------

test "the control weights disable every Skrive signal" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();
    try put(&idx, arena, 0, "target", .heading);

    const ctx = root.RankContext.init(&idx, root.Weights.bm25_only, 0);
    const boost = root.boostFor(ctx, 0, .{
        .modified_millis = 0,
        .inbound_links = 50,
    }, true);

    // Every multiplier neutral: the control arm has to be a real control, or
    // a comparison against it means nothing.
    try std.testing.expectEqual(@as(f32, 1.0), boost.product());
}

test "block kind lifts a heading above prose" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();
    try put(&idx, arena, 0, "target", .paragraph);
    try put(&idx, arena, 1, "target", .heading);

    const hits = try topHits(&idx, gpa, "target ", .{});
    defer gpa.free(hits);
    try std.testing.expectEqual(@as(root.BlockRef, 1), hits[0].block);

    // And the control arm must not reorder them, since the two blocks are
    // otherwise identical.
    const control = try topHits(&idx, gpa, "target ", .{ .weights = root.Weights.bm25_only });
    defer gpa.free(control);
    try std.testing.expectEqual(control[0].score, control[1].score);
}

test "recency decays by half a half-life at a time" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    var idx = root.Index.init(gpa);
    defer idx.deinit();
    try put(&idx, arena_state.allocator(), 0, "target", .paragraph);

    const day = 1000 * 60 * 60 * 24;
    const weights = root.Weights{ .recency_half_life_days = 30, .recency_weight = 0.2 };
    const now: i64 = 365 * day;
    const ctx = root.RankContext.init(&idx, weights, now);

    const fresh = root.boostFor(ctx, 0, .{ .modified_millis = now }, false).recency;
    const one_half_life = root.boostFor(ctx, 0, .{ .modified_millis = now - 30 * day }, false).recency;
    const ancient = root.boostFor(ctx, 0, .{ .modified_millis = 0 }, false).recency;

    try std.testing.expectApproxEqAbs(@as(f32, 1.2), fresh, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 1.1), one_half_life, 0.001);
    // Old notes are outranked by equally good recent ones, never buried.
    try std.testing.expect(ancient >= 1.0 and ancient < 1.01);
}

test "backlink weight saturates so a hub cannot swamp the ranking" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    var idx = root.Index.init(gpa);
    defer idx.deinit();
    try put(&idx, arena_state.allocator(), 0, "target", .paragraph);

    const ctx = root.RankContext.init(&idx, .{}, 0);
    const none = root.boostFor(ctx, 0, .{ .inbound_links = 0 }, false).backlink;
    const one = root.boostFor(ctx, 0, .{ .inbound_links = 1 }, false).backlink;
    const many = root.boostFor(ctx, 0, .{ .inbound_links = 500 }, false).backlink;

    try std.testing.expectEqual(@as(f32, 1.0), none);
    try std.testing.expect(one > none);
    try std.testing.expect(many > one);
    // The five-hundredth link is worth almost nothing over the tenth.
    try std.testing.expect(many < 1.0 + 0.15 + 0.0001);
}

test "a heading that matches lifts the blocks under it" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    var idx = root.Index.init(gpa);
    defer idx.deinit();
    try put(&idx, arena_state.allocator(), 0, "target", .paragraph);

    const ctx = root.RankContext.init(&idx, .{}, 0);
    const under_matching = root.boostFor(ctx, 0, .{}, true).heading;
    const elsewhere = root.boostFor(ctx, 0, .{}, false).heading;

    try std.testing.expect(under_matching > elsewhere);
    try std.testing.expectEqual(@as(f32, 1.0), elsewhere);
}

// ---- top-k ----------------------------------------------------------------

test "a limit caps what is returned without changing what wins" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();
    for (0..50) |i| try put(&idx, arena, @intCast(i), "target filler", .paragraph);

    const all = try topHits(&idx, gpa, "target ", .{});
    defer gpa.free(all);
    const capped = try topHits(&idx, gpa, "target ", .{ .limit = 10 });
    defer gpa.free(capped);

    try std.testing.expectEqual(@as(usize, 50), all.len);
    try std.testing.expectEqual(@as(usize, 10), capped.len);
    for (capped, all[0..capped.len]) |a, b| try std.testing.expectEqual(b.block, a.block);
}
