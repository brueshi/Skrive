//! Snapshots: framing, the store seam, and a simulated backing.
//!
//! A snapshot lets the log be truncated so replay stays fast. Recovery loads
//! the newest valid snapshot and replays the log tail recorded after it,
//! which is why the log is retained since the last *known-good* snapshot
//! rather than the last one written — a corrupt snapshot must always be
//! survivable.
//!
//! **Only a simulated backing lands here.** The seam's job at this stage is
//! to make the corrupt-snapshot fault injectable and the fallback testable,
//! and the payload is opaque bytes until the arena exists. A real on-disk
//! store arrives with the arena, when there is something real to write.
//!
//! Wire format, little-endian:
//!
//!     [magic:8][log_offset:u64][len:u32][crc32:u32][payload: len bytes]
//!
//! The checksum covers everything but itself.

const std = @import("std");
const storage_mod = @import("storage.zig");

const Error = storage_mod.Error;

pub const magic = "SKSNAP01".*;
pub const header_len = 24;

pub const Snapshot = struct {
    /// The log offset this snapshot is current as of. Replay resumes here.
    log_offset: u64,
    /// Borrowed from the decoded image.
    payload: []const u8,
};

fn checksum(head: []const u8, payload: []const u8) u32 {
    var c = std.hash.crc.Crc32.init();
    c.update(head);
    c.update(payload);
    return c.final();
}

/// Frame a snapshot. Caller owns the result.
pub fn encode(
    gpa: std.mem.Allocator,
    log_offset: u64,
    payload: []const u8,
) error{OutOfMemory}![]u8 {
    const out = try gpa.alloc(u8, header_len + payload.len);
    errdefer gpa.free(out);

    @memcpy(out[0..8], &magic);
    std.mem.writeInt(u64, out[8..16], log_offset, .little);
    std.mem.writeInt(u32, out[16..20], @intCast(payload.len), .little);
    // The checksummed head is magic + offset + length: everything before the
    // checksum's own four bytes.
    std.mem.writeInt(u32, out[20..24], checksum(out[0..20], payload), .little);
    @memcpy(out[header_len..], payload);
    return out;
}

/// Validate and read a framed snapshot. Null means "do not trust this one",
/// for every reason a reader could have: wrong magic, short image, a length
/// that runs past the bytes, or a failed checksum.
pub fn decode(image: []const u8) ?Snapshot {
    if (image.len < header_len) return null;
    if (!std.mem.eql(u8, image[0..8], &magic)) return null;

    const log_offset = std.mem.readInt(u64, image[8..16], .little);
    const len = std.mem.readInt(u32, image[16..20], .little);
    const stored_crc = std.mem.readInt(u32, image[20..24], .little);

    if (image.len - header_len != len) return null;
    const payload = image[header_len..];
    if (checksum(image[0..20], payload) != stored_crc) return null;

    return .{ .log_offset = log_offset, .payload = payload };
}

/// The store seam. Kept separate from `Storage` rather than grown onto it:
/// the log needs four operations and the snapshot store needs three
/// different ones, and two small interfaces are easier to hold in the head
/// than one interface with seven.
pub const SnapshotStore = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        write: *const fn (ptr: *anyopaque, index: u64, bytes: []const u8) Error!void,
        read: *const fn (ptr: *anyopaque, gpa: std.mem.Allocator, index: u64) Error!?[]u8,
        /// Indices present, ascending. Caller owns the slice.
        list: *const fn (ptr: *anyopaque, gpa: std.mem.Allocator) Error![]u64,
    };

    pub inline fn write(self: SnapshotStore, index: u64, bytes: []const u8) Error!void {
        return self.vtable.write(self.ptr, index, bytes);
    }

    pub inline fn read(self: SnapshotStore, gpa: std.mem.Allocator, index: u64) Error!?[]u8 {
        return self.vtable.read(self.ptr, gpa, index);
    }

    pub inline fn list(self: SnapshotStore, gpa: std.mem.Allocator) Error![]u64 {
        return self.vtable.list(self.ptr, gpa);
    }
};

pub const SimSnapshotStore = struct {
    gpa: std.mem.Allocator,
    entries: std.AutoArrayHashMapUnmanaged(u64, []u8),

    pub fn init(gpa: std.mem.Allocator) SimSnapshotStore {
        return .{ .gpa = gpa, .entries = .empty };
    }

    pub fn deinit(self: *SimSnapshotStore) void {
        for (self.entries.values()) |v| self.gpa.free(v);
        self.entries.deinit(self.gpa);
        self.* = undefined;
    }

    pub fn store(self: *SimSnapshotStore) SnapshotStore {
        return .{ .ptr = self, .vtable = &vtable };
    }

    /// Damage a stored snapshot in place. The corrupt-snapshot fault acts on
    /// a stored file rather than on the log's byte stream, which is why it
    /// lives here and not in `SimStorage`.
    pub fn corrupt(self: *SimSnapshotStore, index: u64, at_byte: usize, mask: u8) void {
        const bytes = self.entries.get(index) orelse unreachable;
        std.debug.assert(at_byte < bytes.len);
        std.debug.assert(mask != 0);
        bytes[at_byte] ^= mask;
    }

    /// Shorten a stored snapshot, the other way a snapshot arrives damaged.
    pub fn truncate(self: *SimSnapshotStore, index: u64, keep_bytes: usize) void {
        const entry = self.entries.getEntry(index) orelse unreachable;
        std.debug.assert(keep_bytes <= entry.value_ptr.*.len);
        const shorter = self.gpa.alloc(u8, keep_bytes) catch unreachable;
        @memcpy(shorter, entry.value_ptr.*[0..keep_bytes]);
        self.gpa.free(entry.value_ptr.*);
        entry.value_ptr.* = shorter;
    }

    const vtable: SnapshotStore.VTable = .{
        .write = writeFn,
        .read = readFn,
        .list = listFn,
    };

    fn writeFn(ptr: *anyopaque, index: u64, bytes: []const u8) Error!void {
        const self: *SimSnapshotStore = @ptrCast(@alignCast(ptr));
        const copy = try self.gpa.alloc(u8, bytes.len);
        errdefer self.gpa.free(copy);
        @memcpy(copy, bytes);
        const gop = try self.entries.getOrPut(self.gpa, index);
        if (gop.found_existing) self.gpa.free(gop.value_ptr.*);
        gop.value_ptr.* = copy;
    }

    fn readFn(ptr: *anyopaque, gpa: std.mem.Allocator, index: u64) Error!?[]u8 {
        const self: *SimSnapshotStore = @ptrCast(@alignCast(ptr));
        const stored = self.entries.get(index) orelse return null;
        const copy = try gpa.alloc(u8, stored.len);
        @memcpy(copy, stored);
        return copy;
    }

    fn listFn(ptr: *anyopaque, gpa: std.mem.Allocator) Error![]u64 {
        const self: *SimSnapshotStore = @ptrCast(@alignCast(ptr));
        const out = try gpa.alloc(u64, self.entries.count());
        @memcpy(out, self.entries.keys());
        std.mem.sort(u64, out, {}, std.sort.asc(u64));
        return out;
    }
};
