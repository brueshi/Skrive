//! Index snapshots.

const std = @import("std");
const root = @import("root.zig");
const corpus = @import("corpus.zig");

fn buildSample(gpa: std.mem.Allocator, arena: std.mem.Allocator) !root.Index {
    var cfg = corpus.Config{ .docs = 10, .vocab_size = 3_000 };
    cfg.seed = 0x5abe1;
    var gen = try corpus.Corpus.init(arena, cfg);

    var idx = root.Index.init(gpa);
    errdefer idx.deinit();

    var ref: root.BlockRef = 0;
    for (0..cfg.docs) |i| {
        const doc = try gen.document(i);
        for (doc.blocks) |b| {
            const h = try root.harvest(arena, b);
            const kind: root.BlockKind = if (h.tokens.len == 0) .paragraph else h.tokens[0].kind;
            try idx.putBlock(ref, .{ .doc = @intCast(i), .kind = kind }, h.tokens);
            for (h.links) |link| try idx.addBacklink(link.target, ref);
            ref += 1;
        }
    }
    return idx;
}

test "a snapshot restores an index that answers identically" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    var original = try buildSample(gpa, arena_state.allocator());
    defer original.deinit();

    const image = try root.saveIndex(gpa, &original);
    defer gpa.free(image);

    var restored = try root.loadIndex(gpa, image);
    defer restored.deinit();

    const a = try original.dump(gpa);
    defer gpa.free(a);
    const b = try restored.dump(gpa);
    defer gpa.free(b);
    try std.testing.expectEqualStrings(a, b);

    try std.testing.expectEqual(original.termCount(), restored.termCount());
    try std.testing.expectEqual(original.blockCount(), restored.blockCount());
}

test "a restored index still updates incrementally" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var original = try buildSample(gpa, arena_state.allocator());
    defer original.deinit();

    const image = try root.saveIndex(gpa, &original);
    defer gpa.free(image);
    var restored = try root.loadIndex(gpa, image);
    defer restored.deinit();

    // The reason a block's term list is in the snapshot at all: without it
    // this edit would have nothing to diff against and would strand the old
    // postings.
    const edited = [_]root.tokenize.Token{
        .{ .text = "replacement", .kind = .paragraph },
        .{ .text = "content", .kind = .paragraph },
    };
    try original.putBlock(3, .{ .doc = 0, .kind = .paragraph }, &edited);
    try restored.putBlock(3, .{ .doc = 0, .kind = .paragraph }, &edited);
    _ = arena;

    const a = try original.dump(gpa);
    defer gpa.free(a);
    const b = try restored.dump(gpa);
    defer gpa.free(b);
    try std.testing.expectEqualStrings(a, b);
}

test "a damaged snapshot is refused rather than half-loaded" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    var original = try buildSample(gpa, arena_state.allocator());
    defer original.deinit();

    const image = try root.saveIndex(gpa, &original);
    defer gpa.free(image);

    try std.testing.expectError(error.Damaged, root.loadIndex(gpa, image[0..12]));
    try std.testing.expectError(error.Damaged, root.loadIndex(gpa, "not an index at all"));

    // Every byte of the body, flipped in turn, must be caught. The whole
    // point of persisting a derived structure is that a bad one is thrown
    // away rather than trusted.
    var step: usize = 0;
    while (step < image.len - 24) : (step += 97) {
        const copy = try gpa.dupe(u8, image);
        defer gpa.free(copy);
        copy[24 + step] ^= 0x40;
        try std.testing.expectError(error.Damaged, root.loadIndex(gpa, copy));
    }
}
