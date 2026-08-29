//! The simulated storage backend: an in-memory log with an explicit fsync
//! barrier and injectable faults.
//!
//! The model is two byte regions. `committed` is everything that survived the
//! last `sync`; `pending` is everything appended since. A live process reads
//! both, because it cannot tell the difference. A crash can only ever cost
//! `pending` — that asymmetry is the durability contract, and every fault
//! here is a statement about what a reader finds afterward.
//!
//! Nothing in this file consults a clock or an RNG. Faults are parameters,
//! not chance, so a failing case is a value the harness can print and replay.

const std = @import("std");
const storage = @import("storage.zig");

const Storage = storage.Storage;
const Error = storage.Error;
const Fault = storage.Fault;
const CrashError = storage.CrashError;

pub const SimStorage = struct {
    gpa: std.mem.Allocator,
    /// Survived the last fsync. A crash never touches these bytes.
    committed: std.ArrayList(u8),
    /// Appended since the last fsync. A crash may cost any of these.
    pending: std.ArrayList(u8),
    /// Barriers passed, for tests that assert where the boundary fell.
    sync_count: u64,

    pub fn init(gpa: std.mem.Allocator) SimStorage {
        return .{
            .gpa = gpa,
            .committed = .empty,
            .pending = .empty,
            .sync_count = 0,
        };
    }

    pub fn deinit(self: *SimStorage) void {
        self.committed.deinit(self.gpa);
        self.pending.deinit(self.gpa);
        self.* = undefined;
    }

    pub fn storage(self: *SimStorage) Storage {
        return .{ .ptr = self, .vtable = &vtable };
    }

    /// Bytes durable as of the last barrier. The floor every fault must
    /// leave intact.
    pub fn committedLen(self: *const SimStorage) usize {
        return self.committed.items.len;
    }

    /// The image a reader finds after `fault` interrupts this storage.
    /// Caller owns the returned bytes.
    ///
    /// The base image is everything written, including unsynced bytes: the
    /// optimistic case where the OS happened to flush. Faults subtract from
    /// there, which keeps each class a pure, inspectable transformation of a
    /// byte image rather than a rerun of the write path.
    pub fn crashImage(self: *const SimStorage, gpa: std.mem.Allocator, fault: Fault) CrashError![]u8 {
        const committed_len = self.committed.items.len;
        const total = committed_len + self.pending.items.len;

        var image = try gpa.alloc(u8, total);
        errdefer gpa.free(image);
        @memcpy(image[0..committed_len], self.committed.items);
        @memcpy(image[committed_len..], self.pending.items);

        switch (fault) {
            .truncation => |f| {
                std.debug.assert(f.keep_bytes <= total);
                const keep: usize = @intCast(f.keep_bytes);
                if (!gpa.resize(image, keep)) {
                    const shorter = try gpa.alloc(u8, keep);
                    @memcpy(shorter, image[0..keep]);
                    gpa.free(image);
                    return shorter;
                }
                return image[0..keep];
            },
            .torn_sector => |f| {
                std.debug.assert(f.sector_size > 0);
                const start: usize = @as(usize, f.drop_index) * @as(usize, f.sector_size);
                std.debug.assert(start < total);
                const end = @min(start + @as(usize, f.sector_size), total);
                @memset(image[start..end], 0);
                return image;
            },
            .bit_flip => |f| {
                std.debug.assert(f.at_byte < total);
                std.debug.assert(f.mask != 0);
                const at: usize = @intCast(f.at_byte);
                image[at] ^= f.mask;
                return image;
            },
            .lost_unsynced_tail => |f| {
                std.debug.assert(f.page_size > 0);
                var page: usize = 0;
                var at = committed_len;
                while (at < total) : (page += 1) {
                    const end = @min(at + @as(usize, f.page_size), total);
                    const survived = page < 64 and (f.survivor_mask >> @intCast(page)) & 1 == 1;
                    if (!survived) @memset(image[at..end], 0);
                    at = end;
                }
                return image;
            },
            // The image is released by the errdefer above.
            .corrupt_snapshot => return error.NoSnapshot,
        }
    }

    const vtable: Storage.VTable = .{
        .append = appendFn,
        .sync = syncFn,
        .readAll = readAllFn,
        .size = sizeFn,
    };

    fn appendFn(ptr: *anyopaque, bytes: []const u8) Error!void {
        const self: *SimStorage = @ptrCast(@alignCast(ptr));
        try self.pending.appendSlice(self.gpa, bytes);
    }

    fn syncFn(ptr: *anyopaque) Error!void {
        const self: *SimStorage = @ptrCast(@alignCast(ptr));
        try self.committed.appendSlice(self.gpa, self.pending.items);
        self.pending.clearRetainingCapacity();
        self.sync_count += 1;
    }

    fn readAllFn(ptr: *anyopaque, gpa: std.mem.Allocator) Error![]u8 {
        const self: *SimStorage = @ptrCast(@alignCast(ptr));
        const total = self.committed.items.len + self.pending.items.len;
        const buf = try gpa.alloc(u8, total);
        @memcpy(buf[0..self.committed.items.len], self.committed.items);
        @memcpy(buf[self.committed.items.len..], self.pending.items);
        return buf;
    }

    fn sizeFn(ptr: *anyopaque) Error!u64 {
        const self: *SimStorage = @ptrCast(@alignCast(ptr));
        return self.committed.items.len + self.pending.items.len;
    }
};
