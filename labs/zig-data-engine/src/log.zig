//! Record framing, append, and replay — the code that can lose data.
//!
//! The payload is opaque bytes here, deliberately. The log does not need to
//! understand blocks to be proven correct, and the most dangerous code in the
//! project deserves the simplest possible fixtures. Block encoding arrives on
//! top of a log that is already green.
//!
//! Wire format, little-endian throughout so the file is portable:
//!
//!     [len:u32][crc32:u32][type:u8][payload: len bytes]
//!
//! **The checksum covers the length field.** It is computed over
//! `len ++ type ++ payload`, skipping only the checksum's own four bytes. A
//! damaged length is usually caught without this — it either exceeds the
//! limit or redirects the reader to a span whose payload then fails its own
//! checksum — so covering it is defense in depth, not the sole detector. What
//! it buys is diagnosis: the length is verifiable before it is trusted, so
//! damage is reported where it happened rather than as a puzzling failure one
//! record later.

const std = @import("std");
const storage_mod = @import("storage.zig");

const Storage = storage_mod.Storage;

/// Zero is deliberately not a valid tag. The lost-page fault zeroes whole
/// pages, so a zero tag is a second, independent reason such a page is
/// rejected; the checksum is the first. Defense in depth on the exact shape
/// the model injects.
pub const RecordType = enum(u8) {
    put_block = 1,
    delete_block = 2,
};

/// `[len:u32][crc32:u32][type:u8]`
pub const header_len = 9;

/// A corrupted length field must never become a huge allocation or read.
/// This bound is that defense; a real block payload is orders of magnitude
/// smaller.
pub const max_payload_len = 16 * 1024 * 1024;

pub const Record = struct {
    type: RecordType,
    /// Borrowed from the image passed to `replay`, never owned. That is what
    /// lets the harness assert byte-identity against the original directly.
    payload: []const u8,
};

fn checksum(len_le: [4]u8, tag: u8, payload: []const u8) u32 {
    var c = std.hash.crc.Crc32.init();
    c.update(&len_le);
    c.update(&[_]u8{tag});
    c.update(payload);
    return c.final();
}

/// The append side. Holds a reusable scratch buffer so a record reaches
/// storage as one write rather than a header write and a payload write.
pub const Log = struct {
    gpa: std.mem.Allocator,
    storage: Storage,
    scratch: std.ArrayList(u8),

    pub fn init(gpa: std.mem.Allocator, storage: Storage) Log {
        return .{ .gpa = gpa, .storage = storage, .scratch = .empty };
    }

    pub fn deinit(self: *Log) void {
        self.scratch.deinit(self.gpa);
        self.* = undefined;
    }

    pub fn append(self: *Log, record_type: RecordType, payload: []const u8) !void {
        if (payload.len > max_payload_len) return error.PayloadTooLong;

        var len_le: [4]u8 = undefined;
        std.mem.writeInt(u32, &len_le, @intCast(payload.len), .little);
        const tag = @intFromEnum(record_type);

        var crc_le: [4]u8 = undefined;
        std.mem.writeInt(u32, &crc_le, checksum(len_le, tag, payload), .little);

        self.scratch.clearRetainingCapacity();
        try self.scratch.appendSlice(self.gpa, &len_le);
        try self.scratch.appendSlice(self.gpa, &crc_le);
        try self.scratch.append(self.gpa, tag);
        try self.scratch.appendSlice(self.gpa, payload);

        try self.storage.append(self.scratch.items);
    }

    /// The durability barrier. A record is only confirmed after this returns.
    pub fn sync(self: *Log) !void {
        try self.storage.sync();
    }
};

/// Why replay stopped. Every value except `clean_end` names a specific
/// disagreement between the bytes on disk and the format, which is what the
/// harness asserts against and what a log inspector would report.
pub const StopReason = enum {
    /// The image ended exactly on a record boundary.
    clean_end,
    /// Fewer than a header's worth of bytes remained.
    incomplete_header,
    /// The length field exceeded `max_payload_len`.
    length_exceeds_limit,
    /// The header was intact but the payload it claimed ran past the image.
    incomplete_payload,
    /// The record did not match its checksum.
    checksum_mismatch,
    /// A valid, checksummed record of a type this version does not know.
    /// Reachable only from a future writer, never from corruption, because
    /// the checksum covers the type tag.
    unknown_type,
};

pub const Replay = struct {
    records: []Record,
    /// Bytes consumed by the records above — the offset at which replay
    /// stopped, and the point a writer should append from.
    valid_bytes: usize,
    stopped: StopReason,

    pub fn deinit(self: *Replay, gpa: std.mem.Allocator) void {
        gpa.free(self.records);
        self.* = undefined;
    }
};

/// Read every intact record from the front of `image`, stopping at the first
/// one that does not validate. Everything returned is byte-identical to what
/// was appended; a partially written record is never returned in any form.
pub fn replay(gpa: std.mem.Allocator, image: []const u8) error{OutOfMemory}!Replay {
    var records: std.ArrayList(Record) = .empty;
    errdefer records.deinit(gpa);

    var at: usize = 0;
    const stopped: StopReason = reason: while (true) {
        const remaining = image.len - at;
        if (remaining == 0) break :reason .clean_end;
        if (remaining < header_len) break :reason .incomplete_header;

        const len = std.mem.readInt(u32, image[at..][0..4], .little);
        if (len > max_payload_len) break :reason .length_exceeds_limit;

        const total = header_len + @as(usize, len);
        if (remaining < total) break :reason .incomplete_payload;

        const stored_crc = std.mem.readInt(u32, image[at + 4 ..][0..4], .little);
        const tag = image[at + 8];
        const payload = image[at + header_len ..][0..len];

        var len_le: [4]u8 = undefined;
        std.mem.writeInt(u32, &len_le, len, .little);
        if (checksum(len_le, tag, payload) != stored_crc) break :reason .checksum_mismatch;

        // Only reachable with a valid checksum, so this is a version
        // disagreement rather than damage.
        const record_type = std.enums.fromInt(RecordType, tag) orelse
            break :reason .unknown_type;

        try records.append(gpa, .{ .type = record_type, .payload = payload });
        at += total;
    };

    return .{
        .records = try records.toOwnedSlice(gpa),
        .valid_bytes = at,
        .stopped = stopped,
    };
}
