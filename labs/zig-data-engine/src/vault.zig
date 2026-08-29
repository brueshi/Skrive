//! Loading a real directory of Markdown into the index.
//!
//! Everything measured so far ran on generated text, which was right for
//! latency, durability and footprint — all structural — and is useless for
//! ranking. There is no sense in which one block of synthetic words is more
//! relevant to a query than another, so relevance can only be judged on prose
//! somebody actually wrote and can recognize good answers from.
//!
//! This is also where documents stop being a placeholder. Every call site in
//! the benchmark passed `.doc = 0`, so the document dimension existed in the
//! type and nowhere else — which meant no path filtering, no per-document
//! recency, and no way to group results by the file they came from.

const std = @import("std");
const index_mod = @import("index.zig");
const markdown = @import("markdown_scan.zig");
const tokenize = @import("tokenize.zig");

const Index = index_mod.Index;
const BlockRef = index_mod.BlockRef;
const DocRef = index_mod.DocRef;

pub const Stats = struct {
    documents: usize = 0,
    blocks: usize = 0,
    bytes: usize = 0,
    links: usize = 0,
    skipped: usize = 0,
};

/// Index every `.md` file under `root_path`, recursively.
///
/// Documents are registered before their blocks so a block can name its
/// document, and inbound link counts are resolved at the end, once every
/// document's path is known — a link forward to a file not yet walked is
/// ordinary and must not be lost.
pub fn load(
    gpa: std.mem.Allocator,
    io: std.Io,
    root_path: []const u8,
    idx: *Index,
) !Stats {
    var stats = Stats{};

    var dir = try std.Io.Dir.cwd().openDir(io, root_path, .{ .iterate = true });
    defer dir.close(io);

    var walker = try dir.walk(gpa);
    defer walker.deinit();

    var next_block: BlockRef = @intCast(idx.blockCount());

    while (try walker.next(io)) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.endsWith(u8, entry.basename, ".md")) continue;

        const bytes = dir.readFileAlloc(io, entry.path, gpa, .unlimited) catch {
            stats.skipped += 1;
            continue;
        };
        defer gpa.free(bytes);
        stats.bytes += bytes.len;

        const modified: i64 = blk: {
            const file = dir.openFile(io, entry.path, .{}) catch break :blk 0;
            defer file.close(io);
            const st = file.stat(io) catch break :blk 0;
            break :blk st.mtime.toMilliseconds();
        };

        const doc = try idx.addDocument(entry.path, modified);
        stats.documents += 1;

        var file_arena = std.heap.ArenaAllocator.init(gpa);
        defer file_arena.deinit();
        const fa = file_arena.allocator();

        // The most recent heading becomes the section every following block
        // sits under, which is what makes "this section is about the thing
        // you searched for" expressible at all.
        var section: ?BlockRef = null;

        for (try markdown.scan(fa, bytes)) |scanned| {
            const h = try markdown.harvest(fa, scanned);
            const ref = next_block;
            next_block += 1;

            if (scanned.kind == .heading) {
                section = ref;
                try idx.setHeadingLabel(ref, scanned.text);
            }

            try idx.putBlock(ref, .{
                .doc = doc,
                .kind = scanned.kind,
                .heading = if (scanned.kind == .heading) index_mod.no_heading else (section orelse index_mod.no_heading),
            }, h.tokens);

            for (h.links) |link| {
                try idx.addBacklink(link, ref);
                stats.links += 1;
            }
            stats.blocks += 1;
        }
    }

    try idx.resolveInboundLinks();
    return stats;
}
