//! Persisting the index.
//!
//! The engine plan makes indexes derived and never logged, and that stays
//! true: nothing here goes into the write-ahead log, and deleting a snapshot
//! costs a rebuild and never a byte of content. What it changes is the cold
//! path. Rebuilding the index from scratch is 306 ms of a 667 ms start at
//! design scale, against SQLite reopening a persisted index in 1.6 ms, and
//! that gap is felt where the search-latency win is not.
//!
//! **Binary, unlike `.folio`, and for the opposite reason.** The document
//! format is a portability contract that a human and another program must be
//! able to read, so it is deterministic JSON. This is an engine-private cache
//! whose only reader is the code that wrote it, whose only virtue is load
//! speed, and which is thrown away and rebuilt whenever it does not
//! validate. Legibility buys nothing here and costs the whole point.
//!
//! Layout, little-endian header, with a checksum over the body so a damaged
//! cache is detected and discarded rather than trusted:
//!
//!     [magic 8][version u32][checksum u64][endianness u32][body...]
//!
//! **The checksum is Wyhash, not the CRC32 the log uses**, and the difference
//! is the job each one does. The log's CRC guards durability — it decides
//! whether a record survived a crash, over records of a few hundred bytes,
//! and detecting single-bit damage is its whole purpose. This guards cache
//! validity over tens of megabytes, where a table-driven CRC32 runs at a few
//! hundred megabytes a second and costs more than everything else in the load
//! put together. Wyhash is several gigabytes a second and just as good at
//! answering the only question asked here: is this file intact enough to
//! trust, or should the index be rebuilt from the log?
//!
//! The body holds the term texts, the sorted term order, the block table,
//! the postings, each block's term list, and the backlinks — everything an
//! index needs to answer queries *and* to keep updating incrementally. The
//! last of those is the reason a block's term list is stored: without it the
//! first edit after a load would have nothing to diff against and would leave
//! stale postings behind.

const std = @import("std");
const index_mod = @import("index.zig");
const tokenize = @import("tokenize.zig");

const Index = index_mod.Index;
const Posting = index_mod.Posting;
const TermId = index_mod.TermId;
const BlockRef = index_mod.BlockRef;

pub const magic = "SKIDX001".*;
pub const version: u32 = 5;

/// Guards the raw-copy sections below. The snapshot stores postings and
/// per-block term lists as native-endian machine words and restores them with
/// a single copy, which is what takes a load from a hundred milliseconds to a
/// handful. That makes the file machine-specific — and that is fine precisely
/// because it is a disposable cache: a snapshot written elsewhere fails this
/// check, is discarded, and the index rebuilds from the log.
const native_marker: u32 = 0x01020304;

pub const LoadError = error{ OutOfMemory, Damaged };

const Writer = struct {
    gpa: std.mem.Allocator,
    buf: *std.ArrayList(u8),

    fn u32v(self: Writer, v: u32) !void {
        var tmp: [4]u8 = undefined;
        std.mem.writeInt(u32, &tmp, v, .little);
        try self.buf.appendSlice(self.gpa, &tmp);
    }

    fn bytes(self: Writer, s: []const u8) !void {
        try self.u32v(@intCast(s.len));
        try self.buf.appendSlice(self.gpa, s);
    }
};

const Reader = struct {
    src: []const u8,
    at: usize = 0,

    fn u32v(self: *Reader) LoadError!u32 {
        if (self.at + 4 > self.src.len) return error.Damaged;
        const v = std.mem.readInt(u32, self.src[self.at..][0..4], .little);
        self.at += 4;
        return v;
    }

    /// Restore a raw section with one copy. The destination is properly
    /// aligned by construction, so the source's alignment does not matter.
    fn copyInto(self: *Reader, dest: []u8) LoadError!void {
        if (self.at + dest.len > self.src.len) return error.Damaged;
        @memcpy(dest, self.src[self.at..][0..dest.len]);
        self.at += dest.len;
    }

    fn bytes(self: *Reader) LoadError![]const u8 {
        const n = try self.u32v();
        if (self.at + n > self.src.len) return error.Damaged;
        const s = self.src[self.at..][0..n];
        self.at += n;
        return s;
    }
};

/// Serialize `idx`. Caller owns the result.
pub fn save(gpa: std.mem.Allocator, idx: *const Index) ![]u8 {
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(gpa);
    const w = Writer{ .gpa = gpa, .buf = &body };

    try w.u32v(@intCast(idx.terms.items.len));
    for (idx.terms.items) |t| try w.bytes(t);

    try w.u32v(@intCast(idx.sorted.items.len));
    for (idx.sorted.items) |id| try w.u32v(id);
    try w.u32v(@intCast(idx.overlay.items.len));
    for (idx.overlay.items) |id| try w.u32v(id);

    try w.u32v(@intCast(idx.blocks.items.len));
    for (idx.blocks.items, idx.block_live.items) |info, live| {
        try w.u32v(info.doc);
        try w.u32v(info.length);
        try w.u32v(info.heading);
        try body.append(gpa, @intFromEnum(info.kind));
        try body.append(gpa, @intFromBool(live));
    }

    try w.u32v(@intCast(idx.docs.items.len));
    for (idx.docs.items) |d| {
        try w.bytes(d.path);
        try w.u32v(@bitCast(@as(u32, @truncate(@as(u64, @bitCast(d.modified_millis)) >> 32))));
        try w.u32v(@truncate(@as(u64, @bitCast(d.modified_millis))));
        try w.u32v(d.inbound);
    }

    for (idx.postings.items) |list| {
        try w.u32v(@intCast(list.items.len));
        try body.appendSlice(gpa, std.mem.sliceAsBytes(list.items));
    }

    for (idx.block_terms.items) |bt| {
        try w.u32v(@intCast(bt.len));
        try body.appendSlice(gpa, std.mem.sliceAsBytes(bt));
    }

    try w.u32v(@intCast(idx.backlinks.count()));
    var it = idx.backlinks.iterator();
    while (it.next()) |entry| {
        try w.bytes(entry.key_ptr.*);
        try w.u32v(@intCast(entry.value_ptr.items.len));
        for (entry.value_ptr.items) |ref| try w.u32v(ref);
    }

    var out = try gpa.alloc(u8, 24 + body.items.len);
    errdefer gpa.free(out);
    @memcpy(out[0..8], &magic);
    std.mem.writeInt(u32, out[8..12], version, .little);
    std.mem.writeInt(u64, out[12..20], std.hash.Wyhash.hash(0, body.items), .little);
    std.mem.writeInt(u32, out[20..24], native_marker, .native);
    @memcpy(out[24..], body.items);
    return out;
}

/// Rebuild an index from a snapshot. Any damage means the caller rebuilds
/// from the log instead, which is always possible and is why this can be
/// thrown away without ceremony.
pub fn load(gpa: std.mem.Allocator, image: []const u8) LoadError!Index {
    if (image.len < 24) return error.Damaged;
    if (!std.mem.eql(u8, image[0..8], &magic)) return error.Damaged;
    if (std.mem.readInt(u32, image[8..12], .little) != version) return error.Damaged;
    if (std.mem.readInt(u32, image[20..24], .native) != native_marker) return error.Damaged;
    const body = image[24..];
    if (std.hash.Wyhash.hash(0, body) != std.mem.readInt(u64, image[12..20], .little)) {
        return error.Damaged;
    }

    var r = Reader{ .src = body };
    var idx = Index.init(gpa);
    errdefer idx.deinit();

    const term_count = try r.u32v();
    try idx.terms.ensureTotalCapacity(gpa, term_count);
    try idx.postings.ensureTotalCapacity(gpa, term_count);
    try idx.by_text.ensureTotalCapacity(gpa, term_count);
    for (0..term_count) |id| {
        const owned = try gpa.dupe(u8, try r.bytes());
        idx.terms.appendAssumeCapacity(owned);
        idx.by_text.putAssumeCapacity(owned, @intCast(id));
        idx.postings.appendAssumeCapacity(.empty);
    }

    const sorted_count = try r.u32v();
    try idx.sorted.ensureTotalCapacity(gpa, sorted_count);
    for (0..sorted_count) |_| idx.sorted.appendAssumeCapacity(try r.u32v());
    const overlay_count = try r.u32v();
    try idx.overlay.ensureTotalCapacity(gpa, overlay_count);
    for (0..overlay_count) |_| idx.overlay.appendAssumeCapacity(try r.u32v());

    const block_count = try r.u32v();
    try idx.blocks.ensureTotalCapacity(gpa, block_count);
    try idx.block_live.ensureTotalCapacity(gpa, block_count);
    try idx.block_terms.ensureTotalCapacity(gpa, block_count);
    for (0..block_count) |_| {
        const doc = try r.u32v();
        const length = try r.u32v();
        const heading = try r.u32v();
        if (r.at + 2 > r.src.len) return error.Damaged;
        const kind_tag = r.src[r.at];
        const live = r.src[r.at + 1] != 0;
        r.at += 2;
        const kind = std.enums.fromInt(tokenize.BlockKind, kind_tag) orelse return error.Damaged;
        idx.blocks.appendAssumeCapacity(.{
            .doc = doc,
            .kind = kind,
            .heading = heading,
            .length = length,
        });
        idx.block_live.appendAssumeCapacity(live);
        idx.block_terms.appendAssumeCapacity(&.{});
        if (live) {
            idx.live_blocks += 1;
            idx.total_tokens += length;
        }
    }

    const doc_count = try r.u32v();
    try idx.docs.ensureTotalCapacity(gpa, doc_count);
    for (0..doc_count) |_| {
        const path = try gpa.dupe(u8, try r.bytes());
        errdefer gpa.free(path);
        const hi: u64 = try r.u32v();
        const lo: u64 = try r.u32v();
        const inbound = try r.u32v();
        const ref: index_mod.DocRef = @intCast(idx.docs.items.len);
        idx.docs.appendAssumeCapacity(.{
            .path = path,
            .modified_millis = @bitCast((hi << 32) | lo),
            .inbound = inbound,
        });
        try idx.by_path.put(gpa, path, ref);
    }

    for (0..term_count) |id| {
        const n = try r.u32v();
        const list = &idx.postings.items[id];
        try list.resize(gpa, n);
        try r.copyInto(std.mem.sliceAsBytes(list.items));
    }

    for (0..block_count) |b| {
        const n = try r.u32v();
        const slice = try gpa.alloc(index_mod.TermPost, n);
        try r.copyInto(std.mem.sliceAsBytes(slice));
        idx.block_terms.items[b] = slice;
    }

    const backlink_count = try r.u32v();
    for (0..backlink_count) |_| {
        const key = try gpa.dupe(u8, try r.bytes());
        errdefer gpa.free(key);
        const n = try r.u32v();
        var refs: std.ArrayList(BlockRef) = .empty;
        try refs.ensureTotalCapacity(gpa, n);
        for (0..n) |_| refs.appendAssumeCapacity(try r.u32v());
        try idx.backlinks.put(gpa, key, refs);
    }

    return idx;
}
