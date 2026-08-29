//! `zig build corpus -- --tier design --out corpus/design`
//!
//! Writes a synthetic corpus to disk in both encodings and prints what it
//! made. Seeded and clock-free, so the same arguments reproduce the same
//! bytes.

const std = @import("std");
const corpus = @import("corpus.zig");
const folio_write = @import("folio_write.zig");
const md = @import("corpus_markdown.zig");

const usage =
    \\usage: corpus [--tier small|real|design] [--docs N] [--seed N] --out DIR
    \\
    \\  --tier   corpus size preset (default: small)
    \\  --docs   override the tier's document count
    \\  --seed   generator seed (default: 0xc0ffee)
    \\  --out    output directory; folio/ and md/ are created inside it
    \\
;

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const args = try init.minimal.args.toSlice(init.arena.allocator());

    var tier: corpus.Tier = .small;
    var out_dir: ?[]const u8 = null;
    var docs_override: ?usize = null;
    var seed: ?u64 = null;

    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--tier")) {
            i += 1;
            if (i >= args.len) return fail("--tier needs a value");
            tier = std.meta.stringToEnum(corpus.Tier, args[i]) orelse
                return fail("unknown tier");
        } else if (std.mem.eql(u8, arg, "--out")) {
            i += 1;
            if (i >= args.len) return fail("--out needs a value");
            out_dir = args[i];
        } else if (std.mem.eql(u8, arg, "--docs")) {
            i += 1;
            if (i >= args.len) return fail("--docs needs a value");
            docs_override = try std.fmt.parseInt(usize, args[i], 10);
        } else if (std.mem.eql(u8, arg, "--seed")) {
            i += 1;
            if (i >= args.len) return fail("--seed needs a value");
            seed = try std.fmt.parseInt(u64, args[i], 0);
        } else {
            std.debug.print("{s}", .{usage});
            return fail("unknown argument");
        }
    }

    const root = out_dir orelse {
        std.debug.print("{s}", .{usage});
        return fail("--out is required");
    };

    var cfg = corpus.Config.forTier(tier);
    if (docs_override) |d| cfg.docs = d;
    if (seed) |s| cfg.seed = s;

    const paths = init.arena.allocator();
    const cwd = std.Io.Dir.cwd();
    var folio_dir = try cwd.createDirPathOpen(io, try std.fmt.allocPrint(paths, "{s}/folio", .{root}), .{});
    defer folio_dir.close(io);
    var md_dir = try cwd.createDirPathOpen(io, try std.fmt.allocPrint(paths, "{s}/md", .{root}), .{});
    defer md_dir.close(io);

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    var gen = try corpus.Corpus.init(arena_state.allocator(), cfg);
    var stats = corpus.Stats{};

    for (0..cfg.docs) |index| {
        // One arena per document: the corpus as a whole would not fit in
        // memory at the design tier, and it never needs to.
        var doc_arena = std.heap.ArenaAllocator.init(gpa);
        defer doc_arena.deinit();
        gen.beginDocument(doc_arena.allocator());

        const doc = try gen.document(index);
        const slug = try corpus.Corpus.docSlug(doc_arena.allocator(), index);

        const folio_bytes = try folio_write.writeDocument(gpa, doc);
        defer gpa.free(folio_bytes);
        const md_bytes = try md.renderDocument(gpa, doc);
        defer gpa.free(md_bytes);

        try writeFile(io, folio_dir, try std.fmt.allocPrint(doc_arena.allocator(), "{s}.folio", .{slug}), folio_bytes);
        try writeFile(io, md_dir, try std.fmt.allocPrint(doc_arena.allocator(), "{s}.md", .{slug}), md_bytes);

        stats.folio_bytes += folio_bytes.len;
        stats.markdown_bytes += md_bytes.len;
    }

    const generated = gen.finish();
    std.debug.print(
        \\corpus written to {s}
        \\  tier            {t} (seed 0x{x})
        \\  documents       {d}
        \\  blocks          {d}
        \\  words           {d}
        \\  distinct words  {d}
        \\  links           {d}
        \\  tags            {d}
        \\  folio bytes     {Bi:.1}
        \\  markdown bytes  {Bi:.1}
        \\
    , .{
        root,          tier,           cfg.seed,
        generated.documents, generated.blocks, generated.words,
        generated.distinct_words, generated.links, generated.tags,
        stats.folio_bytes, stats.markdown_bytes,
    });
}

fn writeFile(io: std.Io, dir: std.Io.Dir, name: []const u8, bytes: []const u8) !void {
    const file = try dir.createFile(io, name, .{});
    defer file.close(io);
    try file.writePositionalAll(io, bytes, 0);
}

fn fail(message: []const u8) error{BadUsage} {
    std.debug.print("corpus: {s}\n", .{message});
    return error.BadUsage;
}
