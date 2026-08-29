//! Index and query behavior.
//!
//! The load-bearing one is the last: an index built by incremental updates
//! must be indistinguishable from one built fresh. Incremental maintenance is
//! the property that makes re-indexing a saved block cheap, and it is exactly
//! the kind of optimization that silently diverges from the truth it is
//! supposed to be accelerating.

const std = @import("std");
const root = @import("root.zig");
const corpus = @import("corpus.zig");

const Token = root.tokenize.Token;

fn tokens(gpa: std.mem.Allocator, text: []const u8, kind: root.BlockKind) ![]Token {
    var out: std.ArrayList(Token) = .empty;
    var it = std.mem.tokenizeScalar(u8, text, ' ');
    while (it.next()) |w| try out.append(gpa, .{ .text = w, .kind = kind });
    return out.toOwnedSlice(gpa);
}

/// Blocks matching a query, in rank order.
fn searchBlocks(
    idx: *const root.Index,
    gpa: std.mem.Allocator,
    text: []const u8,
) ![]root.BlockRef {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    const query = try root.parseQuery(arena_state.allocator(), text);
    const hits = try root.runQuery(idx, gpa, query);
    defer gpa.free(hits);

    const out = try gpa.alloc(root.BlockRef, hits.len);
    for (hits, out) |h, *slot| slot.* = h.block;
    return out;
}

/// The same, sorted by block. For assertions about *which* blocks match,
/// which must not be coupled to how they happen to rank.
fn matchingBlocks(
    idx: *const root.Index,
    gpa: std.mem.Allocator,
    text: []const u8,
) ![]root.BlockRef {
    const out = try searchBlocks(idx, gpa, text);
    std.mem.sort(root.BlockRef, out, {}, std.sort.asc(root.BlockRef));
    return out;
}

// ---- retrieval ------------------------------------------------------------

test "a conjunction returns only blocks holding every term" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    try idx.putBlock(0, .{ .doc = 0, .kind = .paragraph }, try tokens(arena, "alpha beta gamma", .paragraph));
    try idx.putBlock(1, .{ .doc = 0, .kind = .paragraph }, try tokens(arena, "alpha delta", .paragraph));
    try idx.putBlock(2, .{ .doc = 1, .kind = .paragraph }, try tokens(arena, "beta gamma", .paragraph));

    const both = try matchingBlocks(&idx, gpa, "alpha beta ");
    defer gpa.free(both);
    try std.testing.expectEqualSlices(root.BlockRef, &.{0}, both);

    const one = try matchingBlocks(&idx, gpa, "gamma ");
    defer gpa.free(one);
    try std.testing.expectEqualSlices(root.BlockRef, &.{ 0, 2 }, one);

    const none = try matchingBlocks(&idx, gpa, "absent ");
    defer gpa.free(none);
    try std.testing.expectEqual(@as(usize, 0), none.len);
}

test "the trailing token matches as a prefix" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    try idx.putBlock(0, .{ .doc = 0, .kind = .paragraph }, try tokens(arena, "reconcile", .paragraph));
    try idx.putBlock(1, .{ .doc = 0, .kind = .paragraph }, try tokens(arena, "reconciliation", .paragraph));
    try idx.putBlock(2, .{ .doc = 0, .kind = .paragraph }, try tokens(arena, "record", .paragraph));
    try idx.putBlock(3, .{ .doc = 0, .kind = .paragraph }, try tokens(arena, "unrelated", .paragraph));

    // Mid-word: still being typed, so it matches by prefix.
    const typing = try matchingBlocks(&idx, gpa, "reconcil");
    defer gpa.free(typing);
    try std.testing.expectEqualSlices(root.BlockRef, &.{ 0, 1 }, typing);

    // Finished: an exact term, so the longer word no longer matches.
    const finished = try matchingBlocks(&idx, gpa, "reconcile ");
    defer gpa.free(finished);
    try std.testing.expectEqualSlices(root.BlockRef, &.{0}, finished);

    const broad = try matchingBlocks(&idx, gpa, "rec");
    defer gpa.free(broad);
    try std.testing.expectEqual(@as(usize, 3), broad.len);
}

test "prefix expansion survives the overlay merge" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    // Comfortably past the overlay cap, so several merges happen — the
    // point where a prefix query could silently lose terms to whichever run
    // it forgot to consult.
    for (0..3000) |i| {
        const text = try std.fmt.allocPrint(arena, "term{d:0>4} filler", .{i});
        try idx.putBlock(@intCast(i), .{ .doc = 0, .kind = .paragraph }, try tokens(arena, text, .paragraph));
    }

    // Assert the merge path actually ran, rather than trusting the term
    // count to have crossed a threshold defined elsewhere.
    try std.testing.expect(idx.merges > 1);
    try std.testing.expect(idx.overlay.items.len > 0);

    const found = try idx.prefixTerms(gpa, "term00");
    defer gpa.free(found);
    // term0000 through term0099.
    try std.testing.expectEqual(@as(usize, 100), found.len);

    const all = try idx.prefixTerms(gpa, "term");
    defer gpa.free(all);
    try std.testing.expectEqual(@as(usize, 3000), all.len);
}

test "headings outrank prose for the same term" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var idx = root.Index.init(gpa);
    defer idx.deinit();

    try idx.putBlock(0, .{ .doc = 0, .kind = .paragraph }, try tokens(arena, "durability", .paragraph));
    try idx.putBlock(1, .{ .doc = 0, .kind = .heading }, try tokens(arena, "durability", .heading));

    const hits = try searchBlocks(&idx, gpa, "durability ");
    defer gpa.free(hits);
    try std.testing.expectEqualSlices(root.BlockRef, &.{ 1, 0 }, hits);
}

test "backlinks resolve to their source blocks" {
    const gpa = std.testing.allocator;
    var idx = root.Index.init(gpa);
    defer idx.deinit();

    try idx.addBacklink("note-00002.md", 7);
    try idx.addBacklink("note-00002.md", 9);
    try idx.addBacklink("note-00003.md", 7);

    try std.testing.expectEqualSlices(root.BlockRef, &.{ 7, 9 }, idx.backlinksTo("note-00002.md"));
    try std.testing.expectEqual(@as(usize, 0), idx.backlinksTo("note-99999.md").len);
}

// ---- the incremental-update invariant -------------------------------------

const Revision = struct { ref: root.BlockRef, text: []const u8, kind: root.BlockKind };

fn buildFresh(gpa: std.mem.Allocator, arena: std.mem.Allocator, state: []const Revision) !root.Index {
    var idx = root.Index.init(gpa);
    errdefer idx.deinit();
    for (state) |r| {
        try idx.putBlock(r.ref, .{ .doc = 0, .kind = r.kind }, try tokens(arena, r.text, r.kind));
    }
    return idx;
}

test "an incrementally updated index equals a freshly built one" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const initial = [_]Revision{
        // "the" appears twice here and three times after the edit: a term
        // retained across the edit whose frequency moves, which is the one
        // branch of the diff a naive implementation silently skips.
        .{ .ref = 0, .text = "the log is the truth", .kind = .paragraph },
        .{ .ref = 1, .text = "durability concentrates in the replay cycle", .kind = .heading },
        .{ .ref = 2, .text = "indexes are derived and disposable", .kind = .paragraph },
        .{ .ref = 3, .text = "a block is the unit of exchange", .kind = .list_item },
    };

    // Edits of every shape the diff has to handle: a term added, a term
    // dropped, a frequency changed, a block emptied, and a block untouched.
    const edited = [_]Revision{
        .{ .ref = 0, .text = "the log is the truth and the cache", .kind = .paragraph },
        .{ .ref = 1, .text = "durability concentrates in the replay cycle", .kind = .heading },
        .{ .ref = 2, .text = "", .kind = .paragraph },
        .{ .ref = 3, .text = "a block is the unit of exchange", .kind = .list_item },
        .{ .ref = 4, .text = "snapshots let the log be truncated", .kind = .paragraph },
    };

    var incremental = try buildFresh(gpa, arena, &initial);
    defer incremental.deinit();
    for (edited) |r| {
        try incremental.putBlock(r.ref, .{ .doc = 0, .kind = r.kind }, try tokens(arena, r.text, r.kind));
    }

    var fresh = try buildFresh(gpa, arena, &edited);
    defer fresh.deinit();

    const a = try incremental.dump(gpa);
    defer gpa.free(a);
    const b = try fresh.dump(gpa);
    defer gpa.free(b);

    try std.testing.expectEqualStrings(b, a);
}

test "removing a block leaves the index as if it were never added" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const keep = [_]Revision{
        .{ .ref = 0, .text = "alpha beta", .kind = .paragraph },
        .{ .ref = 2, .text = "gamma delta", .kind = .paragraph },
    };

    var with_removal = try buildFresh(gpa, arena, &keep);
    defer with_removal.deinit();
    try with_removal.putBlock(1, .{ .doc = 0, .kind = .paragraph }, try tokens(arena, "epsilon beta", .paragraph));
    try with_removal.removeBlock(1);

    var never = try buildFresh(gpa, arena, &keep);
    defer never.deinit();

    const a = try with_removal.dump(gpa);
    defer gpa.free(a);
    const b = try never.dump(gpa);
    defer gpa.free(b);

    try std.testing.expectEqualStrings(b, a);
}

test "the invariant holds over generated documents, not just hand-written ones" {
    const gpa = std.testing.allocator;

    var persistent = std.heap.ArenaAllocator.init(gpa);
    defer persistent.deinit();

    var cfg = corpus.Config{ .docs = 12, .vocab_size = 4_000 };
    cfg.seed = 0x5eed;
    var gen = try corpus.Corpus.init(persistent.allocator(), cfg);

    // Generate once and keep the trees: both indexes must see identical input.
    var docs: std.ArrayList(root.folio.Document) = .empty;
    for (0..cfg.docs) |i| try docs.append(persistent.allocator(), try gen.document(i));

    var incremental = root.Index.init(gpa);
    defer incremental.deinit();
    var fresh = root.Index.init(gpa);
    defer fresh.deinit();

    var ref: root.BlockRef = 0;
    for (docs.items) |doc| {
        for (doc.blocks) |b| {
            var block_arena = std.heap.ArenaAllocator.init(gpa);
            defer block_arena.deinit();
            const h = try root.harvest(block_arena.allocator(), b);
            const kind: root.BlockKind = if (h.tokens.len == 0) .paragraph else h.tokens[0].kind;

            // The incremental index sees the block twice: once as a partial
            // draft, then as the real content, which is what a save does.
            // The draft is a prefix of the final tokens rather than empty, so
            // most terms are retained across the update with a changed
            // frequency instead of every term being a fresh insert.
            try incremental.putBlock(
                ref,
                .{ .doc = 0, .kind = kind },
                h.tokens[0 .. h.tokens.len / 2],
            );
            try incremental.putBlock(ref, .{ .doc = 0, .kind = kind }, h.tokens);
            try fresh.putBlock(ref, .{ .doc = 0, .kind = kind }, h.tokens);
            ref += 1;
        }
    }

    try std.testing.expect(ref > 100);
    try std.testing.expect(incremental.termCount() > 500);

    const a = try incremental.dump(gpa);
    defer gpa.free(a);
    const b = try fresh.dump(gpa);
    defer gpa.free(b);

    try std.testing.expectEqualStrings(b, a);
}
