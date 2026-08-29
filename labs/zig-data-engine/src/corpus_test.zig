//! Corpus generator properties.
//!
//! Three things have to hold for the numbers this corpus eventually produces
//! to mean anything: it must be reproducible, it must be spec-conformant, and
//! its term distribution must be skewed the way prose is. The last one is the
//! easiest to lose silently and the most damaging — a uniform vocabulary
//! gives every term a short postings list and makes search look fast for a
//! reason that has nothing to do with the index.

const std = @import("std");
const root = @import("root.zig");
const corpus = @import("corpus.zig");

const test_config = corpus.Config{ .docs = 6, .vocab_size = 800 };

/// Generate `cfg.docs` documents and return their concatenated canonical
/// bytes, which stands in for "the corpus" in comparisons.
fn generate(gpa: std.mem.Allocator, cfg: corpus.Config) ![]u8 {
    var persistent = std.heap.ArenaAllocator.init(gpa);
    defer persistent.deinit();

    var gen = try corpus.Corpus.init(persistent.allocator(), cfg);

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);

    for (0..cfg.docs) |i| {
        var doc_arena = std.heap.ArenaAllocator.init(gpa);
        defer doc_arena.deinit();
        gen.beginDocument(doc_arena.allocator());

        const doc = try gen.document(i);
        const bytes = try root.writeFolio(gpa, doc);
        defer gpa.free(bytes);
        try out.appendSlice(gpa, bytes);
    }
    return out.toOwnedSlice(gpa);
}

test "the same seed reproduces the corpus byte-for-byte" {
    const gpa = std.testing.allocator;

    const first = try generate(gpa, test_config);
    defer gpa.free(first);
    const second = try generate(gpa, test_config);
    defer gpa.free(second);

    try std.testing.expectEqualStrings(first, second);
}

test "a different seed produces a different corpus" {
    const gpa = std.testing.allocator;

    const first = try generate(gpa, test_config);
    defer gpa.free(first);

    var other = test_config;
    other.seed = test_config.seed + 1;
    const second = try generate(gpa, other);
    defer gpa.free(second);

    try std.testing.expect(!std.mem.eql(u8, first, second));
}

test "the document arena can be swapped without changing what is generated" {
    const gpa = std.testing.allocator;

    // `generate` swaps arenas per document; this builds everything in one.
    var persistent = std.heap.ArenaAllocator.init(gpa);
    defer persistent.deinit();
    var gen = try corpus.Corpus.init(persistent.allocator(), test_config);

    var single: std.ArrayList(u8) = .empty;
    defer single.deinit(gpa);
    for (0..test_config.docs) |i| {
        const doc = try gen.document(i);
        const bytes = try root.writeFolio(gpa, doc);
        defer gpa.free(bytes);
        try single.appendSlice(gpa, bytes);
    }

    const swapped = try generate(gpa, test_config);
    defer gpa.free(swapped);

    try std.testing.expectEqualStrings(single.items, swapped);
}

test "every generated document is spec-conformant" {
    const gpa = std.testing.allocator;

    var persistent = std.heap.ArenaAllocator.init(gpa);
    defer persistent.deinit();
    var gen = try corpus.Corpus.init(persistent.allocator(), test_config);

    for (0..test_config.docs) |i| {
        var doc_arena = std.heap.ArenaAllocator.init(gpa);
        defer doc_arena.deinit();
        gen.beginDocument(doc_arena.allocator());

        const written = try root.writeFolio(gpa, try gen.document(i));
        defer gpa.free(written);

        // The generator's output must survive the same round trip the
        // conformance fixtures do, or the corpus is not a corpus of `.folio`.
        var round = std.heap.ArenaAllocator.init(gpa);
        defer round.deinit();
        const reparsed = try root.writeFolio(gpa, try root.parseFolio(round.allocator(), written));
        defer gpa.free(reparsed);

        try std.testing.expectEqualStrings(written, reparsed);
    }
}

/// Collect the prose words a document actually contains, by walking the block
/// tree. Deliberately not by tokenizing the serialized form: that counts JSON
/// keys like `kind` and `marks`, which appear once per node and swamp every
/// real word, so the tally would describe the encoding rather than the
/// vocabulary and would pass no matter how words were sampled.
fn collectWords(
    gpa: std.mem.Allocator,
    counts: *std.StringHashMapUnmanaged(usize),
    blocks: []const root.folio.Block,
) !void {
    for (blocks) |b| switch (b.body) {
        .paragraph => |p| try tallyInlines(gpa, counts, p.inline_content),
        .heading => |h| try tallyInlines(gpa, counts, h.inline_content),
        .blockquote => |q| try collectWords(gpa, counts, q.children),
        .footnote_definition => |f| try collectWords(gpa, counts, f.children),
        .bullet_list => |l| for (l.items) |item| try collectWords(gpa, counts, item.children),
        .ordered_list => |l| for (l.items) |item| try collectWords(gpa, counts, item.children),
        .table => |t| for (t.rows) |row| for (row) |cell| try tallyInlines(gpa, counts, cell),
        .code_block, .horizontal_rule => {},
    };
}

fn tallyInlines(
    gpa: std.mem.Allocator,
    counts: *std.StringHashMapUnmanaged(usize),
    inlines: []const root.folio.Inline,
) !void {
    for (inlines) |n| {
        const text = switch (n) {
            .text => |t| t.text,
            else => continue,
        };
        var it = std.mem.tokenizeAny(u8, text, " .");
        while (it.next()) |word| {
            const gop = try counts.getOrPut(gpa, word);
            if (!gop.found_existing) gop.value_ptr.* = 0;
            gop.value_ptr.* += 1;
        }
    }
}

test "the term distribution is Zipf-skewed, not uniform" {
    const gpa = std.testing.allocator;

    var cfg = test_config;
    cfg.docs = 40;
    // Sized like a real tier rather than like the other tests: a small pool
    // saturates at this token count and every term ends up common, which is
    // precisely the flat distribution this test exists to reject.
    cfg.vocab_size = 20_000;

    // One arena for everything: the tally borrows its keys from the block
    // tree, so the documents outlive the counting.
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var gen = try corpus.Corpus.init(arena_state.allocator(), cfg);

    var counts: std.StringHashMapUnmanaged(usize) = .empty;
    defer counts.deinit(gpa);

    for (0..cfg.docs) |i| {
        const doc = try gen.document(i);
        try collectWords(gpa, &counts, doc.blocks);
    }

    var frequencies: std.ArrayList(usize) = .empty;
    defer frequencies.deinit(gpa);
    var it = counts.valueIterator();
    while (it.next()) |v| try frequencies.append(gpa, v.*);

    std.mem.sort(usize, frequencies.items, {}, std.sort.desc(usize));
    try std.testing.expect(frequencies.items.len > 200);

    // Under uniform sampling these land within a small factor of each other.
    // Zipf puts an order of magnitude between them.
    const head = frequencies.items[0];
    const rank_100 = frequencies.items[100];
    try std.testing.expect(head > rank_100 * 10);

    // And the tail must be genuinely long: most terms appear a handful of
    // times, which is what makes a postings-list index worth having.
    const median = frequencies.items[frequencies.items.len / 2];
    try std.testing.expect(median <= 4);
}
