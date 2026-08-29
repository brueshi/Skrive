//! Document-level results.
//!
//! The behaviour under test is the one real prose forced: a query's terms are
//! satisfied across a document rather than within a single block, because a
//! writer introduces a subject in one paragraph and develops it in the next,
//! and a strict per-block conjunction finds almost none of that.

const std = @import("std");
const root = @import("root.zig");

const Token = root.tokenize.Token;

const Fixture = struct {
    idx: root.Index,
    arena: std.heap.ArenaAllocator,
    next: root.BlockRef = 0,

    fn init(gpa: std.mem.Allocator) Fixture {
        return .{ .idx = root.Index.init(gpa), .arena = std.heap.ArenaAllocator.init(gpa) };
    }

    fn deinit(self: *Fixture) void {
        self.idx.deinit();
        self.arena.deinit();
    }

    fn doc(self: *Fixture, path: []const u8) !root.DocRef {
        return self.idx.addDocument(path, 0);
    }

    fn block(
        self: *Fixture,
        doc_ref: root.DocRef,
        kind: root.BlockKind,
        heading: root.BlockRef,
        text: []const u8,
    ) !root.BlockRef {
        const a = self.arena.allocator();
        var out: std.ArrayList(Token) = .empty;
        var it = std.mem.tokenizeScalar(u8, text, ' ');
        while (it.next()) |w| try out.append(a, .{ .text = w, .kind = kind });

        const ref = self.next;
        self.next += 1;
        try self.idx.putBlock(ref, .{ .doc = doc_ref, .kind = kind, .heading = heading }, out.items);
        if (kind == .heading) try self.idx.setHeadingLabel(ref, text);
        return ref;
    }

    fn search(self: *Fixture, gpa: std.mem.Allocator, text: []const u8) ![]root.DocHit {
        var a = std.heap.ArenaAllocator.init(gpa);
        defer a.deinit();
        const query = try root.parseQuery(a.allocator(), text);
        return root.runDocuments(&self.idx, gpa, query, .{});
    }
};

test "terms are satisfied across a document, not within one block" {
    const gpa = std.testing.allocator;
    var f = Fixture.init(gpa);
    defer f.deinit();

    // Split across two paragraphs, the way prose actually reads.
    const split = try f.doc("split.md");
    _ = try f.block(split, .paragraph, root.no_heading, "the durability story matters here");
    _ = try f.block(split, .paragraph, root.no_heading, "and the harness proves it");

    // Only half the query.
    const partial = try f.doc("partial.md");
    _ = try f.block(partial, .paragraph, root.no_heading, "durability alone with padding words");

    const hits = try f.search(gpa, "durability harness ");
    defer root.freeDocHits(gpa, hits);

    try std.testing.expectEqual(@as(usize, 1), hits.len);
    try std.testing.expectEqual(split, hits[0].doc);
    try std.testing.expectEqual(@as(usize, 2), hits[0].blocks.len);
}

test "a block carrying more of the query leads its document" {
    const gpa = std.testing.allocator;
    var f = Fixture.init(gpa);
    defer f.deinit();

    const d = try f.doc("one.md");
    _ = try f.block(d, .paragraph, root.no_heading, "durability on its own");
    const both = try f.block(d, .paragraph, root.no_heading, "durability and harness together");
    _ = try f.block(d, .paragraph, root.no_heading, "harness on its own");

    const hits = try f.search(gpa, "durability harness ");
    defer root.freeDocHits(gpa, hits);

    try std.testing.expectEqual(@as(usize, 1), hits.len);
    try std.testing.expectEqual(both, hits[0].blocks[0].block);
    try std.testing.expectEqual(@as(u32, 2), hits[0].blocks[0].matched_terms);
}

test "coverage outranks raw score when ordering a document's blocks" {
    const gpa = std.testing.allocator;
    var f = Fixture.init(gpa);
    defer f.deinit();

    const d = try f.doc("doc.md");

    // Long, and carries both terms.
    const covering = try f.block(d, .paragraph, root.no_heading,
        "common rare padding padding padding padding padding padding padding padding padding padding");
    // Short, and carries only the rarer one — so BM25 alone scores it higher,
    // being brief and containing an uncommon word.
    const sharp = try f.block(d, .paragraph, root.no_heading, "rare");

    // Make "common" genuinely common so the two blocks separate on score.
    for (0..60) |_| _ = try f.block(try f.doc("filler.md"), .paragraph, root.no_heading, "common filler");

    const hits = try f.search(gpa, "common rare ");
    defer root.freeDocHits(gpa, hits);

    try std.testing.expectEqual(@as(usize, 1), hits.len);
    try std.testing.expect(hits[0].blocks.len >= 2);

    // The block answering the whole query leads, even though the other one
    // scores higher on its own. A result that covers what was asked is worth
    // more than a result that is merely emphatic about part of it.
    try std.testing.expectEqual(covering, hits[0].blocks[0].block);
    try std.testing.expectEqual(sharp, hits[0].blocks[1].block);
    try std.testing.expect(hits[0].blocks[1].score > hits[0].blocks[0].score);
}

test "one long document cannot fill every result slot" {
    const gpa = std.testing.allocator;
    var f = Fixture.init(gpa);
    defer f.deinit();

    // Twenty matching blocks in one document, one in each of three others.
    const long = try f.doc("long.md");
    for (0..20) |_| _ = try f.block(long, .paragraph, root.no_heading, "target padding padding");
    for (0..3) |i| {
        const other = try f.doc(try std.fmt.allocPrint(f.arena.allocator(), "other{d}.md", .{i}));
        _ = try f.block(other, .paragraph, root.no_heading, "target padding padding");
    }

    const hits = try f.search(gpa, "target ");
    defer root.freeDocHits(gpa, hits);

    // Four documents, not twenty-three blocks with one document owning most.
    try std.testing.expectEqual(@as(usize, 4), hits.len);
    try std.testing.expectEqual(@as(usize, 20), hits[0].blocks.len);
    try std.testing.expectEqual(long, hits[0].doc);
}

test "extra matching blocks help a document but do not decide it" {
    const gpa = std.testing.allocator;
    var f = Fixture.init(gpa);
    defer f.deinit();

    const many = try f.doc("many.md");
    for (0..5) |_| _ = try f.block(many, .paragraph, root.no_heading, "target padding padding padding");

    // One block, but a much better one: the term is most of it.
    const sharp = try f.doc("sharp.md");
    _ = try f.block(sharp, .paragraph, root.no_heading, "target");

    const hits = try f.search(gpa, "target ");
    defer root.freeDocHits(gpa, hits);

    try std.testing.expectEqual(@as(usize, 2), hits.len);
    // The precise document wins: mentioning something five times in passing
    // is not the same as being about it.
    try std.testing.expectEqual(sharp, hits[0].doc);
    // But the tail still counted for something.
    try std.testing.expect(hits[1].score > hits[1].blocks[0].score);
}

test "a document answering the whole query beats one answering half of it" {
    const gpa = std.testing.allocator;
    var f = Fixture.init(gpa);
    defer f.deinit();

    // Its best block is a short heading carrying only the common term, which
    // BM25 scores highly for being brief.
    const partial = try f.doc("partial.md");
    _ = try f.block(partial, .heading, root.no_heading, "identity");
    _ = try f.block(partial, .paragraph, root.no_heading, "block mentioned far away in other prose");

    // Its best block is longer, scores lower on its own, and answers the
    // whole question.
    const whole = try f.doc("whole.md");
    _ = try f.block(whole, .paragraph, root.no_heading, "block identity is what this paragraph is about");

    for (0..40) |_| _ = try f.block(try f.doc("filler.md"), .paragraph, root.no_heading, "identity filler");

    const hits = try f.search(gpa, "block identity ");
    defer root.freeDocHits(gpa, hits);

    try std.testing.expectEqual(@as(usize, 2), hits.len);
    try std.testing.expectEqual(whole, hits[0].doc);
    try std.testing.expectEqual(@as(u32, 2), hits[0].blocks[0].matched_terms);

    // The partial document's leading block genuinely scores higher; it is the
    // document ranking that puts the complete answer first.
    try std.testing.expect(hits[1].blocks[0].score > hits[0].blocks[0].score);
}

test "a limit caps documents rather than blocks" {
    const gpa = std.testing.allocator;
    var f = Fixture.init(gpa);
    defer f.deinit();

    for (0..10) |i| {
        const d = try f.doc(try std.fmt.allocPrint(f.arena.allocator(), "d{d}.md", .{i}));
        _ = try f.block(d, .paragraph, root.no_heading, "target padding");
        _ = try f.block(d, .paragraph, root.no_heading, "target other");
    }

    var a = std.heap.ArenaAllocator.init(gpa);
    defer a.deinit();
    const query = try root.parseQuery(a.allocator(), "target ");
    const hits = try root.runDocuments(&f.idx, gpa, query, .{ .limit = 3 });
    defer root.freeDocHits(gpa, hits);

    try std.testing.expectEqual(@as(usize, 3), hits.len);
    for (hits) |h| try std.testing.expectEqual(@as(usize, 2), h.blocks.len);
}

test "a breadcrumb names the section a block sits in" {
    const gpa = std.testing.allocator;
    var f = Fixture.init(gpa);
    defer f.deinit();

    const d = try f.doc("doc.md");
    const heading = try f.block(d, .heading, root.no_heading, "## The flush ack fix");
    const body = try f.block(d, .paragraph, heading, "the host waited forever");
    const orphan = try f.block(d, .paragraph, root.no_heading, "before any heading");

    try std.testing.expectEqualStrings("The flush ack fix", f.idx.breadcrumb(body).?);
    // A heading is its own breadcrumb, not its parent's.
    try std.testing.expectEqualStrings("The flush ack fix", f.idx.breadcrumb(heading).?);
    try std.testing.expectEqual(@as(?[]const u8, null), f.idx.breadcrumb(orphan));
}
