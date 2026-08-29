//! The `.md` block scanner.

const std = @import("std");
const root = @import("root.zig");
const markdown = @import("markdown_scan.zig");
const corpus = @import("corpus.zig");
const md_render = @import("corpus_markdown.zig");

test "blank lines separate blocks and leading syntax names the kind" {
    const gpa = std.testing.allocator;
    const source =
        \\# A title
        \\
        \\Some prose that runs
        \\across two lines.
        \\
        \\- one
        \\- two
        \\
        \\> quoted
        \\
        \\1. first
        \\
        \\| a | b |
        \\| --- | --- |
        \\
        \\[^1]: a note
        \\
        \\---
        \\
    ;
    const blocks = try markdown.scan(gpa, source);
    defer gpa.free(blocks);

    const kinds = [_]root.BlockKind{
        .heading, .paragraph, .list_item, .quote,
        .list_item, .table_cell, .footnote, .paragraph,
    };
    try std.testing.expectEqual(kinds.len, blocks.len);
    for (blocks, kinds) |b, want| try std.testing.expectEqual(want, b.kind);
}

test "a fenced block keeps its blank lines instead of splitting on them" {
    const gpa = std.testing.allocator;
    const source =
        \\before
        \\
        \\```ts
        \\const a = 1;
        \\
        \\const b = 2;
        \\```
        \\
        \\after
        \\
    ;
    const blocks = try markdown.scan(gpa, source);
    defer gpa.free(blocks);

    try std.testing.expectEqual(@as(usize, 3), blocks.len);
    try std.testing.expectEqual(root.BlockKind.code, blocks[1].kind);
    try std.testing.expect(std.mem.indexOf(u8, blocks[1].text, "const b = 2;") != null);
}

test "a heading does not absorb the paragraph beneath it" {
    const gpa = std.testing.allocator;
    // No blank line between them, which is how people actually write.
    const source =
        \\## The flush-ack fix
        \\The host was waiting on an acknowledgement that never came.
        \\
        \\Separate paragraph.
        \\
    ;
    const blocks = try markdown.scan(gpa, source);
    defer gpa.free(blocks);

    try std.testing.expectEqual(@as(usize, 3), blocks.len);
    try std.testing.expectEqual(root.BlockKind.heading, blocks[0].kind);
    try std.testing.expectEqualStrings("## The flush-ack fix", std.mem.trimEnd(u8, blocks[0].text, "\n"));
    try std.testing.expectEqual(root.BlockKind.paragraph, blocks[1].kind);
    try std.testing.expect(std.mem.startsWith(u8, blocks[1].text, "The host was waiting"));
}

test "a hash without a space is prose, not a heading" {
    const gpa = std.testing.allocator;
    const blocks = try markdown.scan(gpa, "#notaheading is a tag\n");
    defer gpa.free(blocks);
    try std.testing.expectEqual(@as(usize, 1), blocks.len);
    try std.testing.expectEqual(root.BlockKind.paragraph, blocks[0].kind);
}

test "a link's label is prose and its target is a link, never a term" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const blocks = try markdown.scan(arena, "see [the other note](note-00007.md) for more\n");
    const h = try markdown.harvest(arena, blocks[0]);

    try std.testing.expectEqual(@as(usize, 1), h.links.len);
    try std.testing.expectEqualStrings("note-00007.md", h.links[0]);

    // The label survives as searchable words; the target does not leak in, or
    // every note would match the words in its neighbours' filenames.
    var saw_label = false;
    for (h.tokens) |t| {
        if (std.mem.eql(u8, t.text, "other")) saw_label = true;
        try std.testing.expect(!std.mem.eql(u8, t.text, "00007"));
    }
    try std.testing.expect(saw_label);
}

test "the two encodings of a document hold the same number of blocks" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var cfg = corpus.Config{ .docs = 8, .vocab_size = 2_000 };
    cfg.seed = 0xd0c;
    var gen = try corpus.Corpus.init(arena, cfg);

    // The benchmark reports identical block counts for the two tiers at
    // corpus scale. That is a property of the renderer separating blocks with
    // a blank line, not a coincidence, so it is pinned here: if it ever
    // stops holding, the two arms stop being comparable.
    for (0..cfg.docs) |i| {
        const doc = try gen.document(i);
        const rendered = try md_render.renderDocument(arena, doc);
        const scanned = try markdown.scan(arena, rendered);
        try std.testing.expectEqual(doc.blocks.len, scanned.len);
    }
}
