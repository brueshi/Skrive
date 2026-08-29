//! The real storage backend: an append-only file on disk, on top of
//! `std.Io` so the syscall path matches `shell-zig/core`'s convention.
//!
//! Appends are positional writes against a cursor this type owns rather than
//! the file's shared seek position. That keeps the append offset explicit and
//! independent of anything else holding the descriptor, which matters because
//! replay reasons about absolute offsets.

const std = @import("std");
const storage = @import("storage.zig");

const Storage = storage.Storage;
const Error = storage.Error;

pub const RealStorage = struct {
    io: std.Io,
    file: std.Io.File,
    /// The append cursor, and therefore the log's length.
    end: u64,

    /// Open the log, creating it if absent. Never truncates: an existing log
    /// is the record of truth and reopening must not destroy it.
    pub fn open(io: std.Io, dir: std.Io.Dir, sub_path: []const u8) Error!RealStorage {
        const file = dir.createFile(io, sub_path, .{
            .read = true,
            .truncate = false,
        }) catch return error.WriteFailed;
        const end = file.length(io) catch {
            file.close(io);
            return error.ReadFailed;
        };
        return .{ .io = io, .file = file, .end = end };
    }

    pub fn close(self: *RealStorage) void {
        self.file.close(self.io);
        self.* = undefined;
    }

    pub fn storage(self: *RealStorage) Storage {
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: Storage.VTable = .{
        .append = appendFn,
        .sync = syncFn,
        .readAll = readAllFn,
        .size = sizeFn,
    };

    fn appendFn(ptr: *anyopaque, bytes: []const u8) Error!void {
        const self: *RealStorage = @ptrCast(@alignCast(ptr));
        self.file.writePositionalAll(self.io, bytes, self.end) catch return error.WriteFailed;
        self.end += bytes.len;
    }

    fn syncFn(ptr: *anyopaque) Error!void {
        const self: *RealStorage = @ptrCast(@alignCast(ptr));
        self.file.sync(self.io) catch return error.SyncFailed;
    }

    fn readAllFn(ptr: *anyopaque, gpa: std.mem.Allocator) Error![]u8 {
        const self: *RealStorage = @ptrCast(@alignCast(ptr));
        const buf = try gpa.alloc(u8, self.end);
        errdefer gpa.free(buf);
        const n = self.file.readPositionalAll(self.io, buf, 0) catch return error.ReadFailed;
        if (n != buf.len) return error.ReadFailed;
        return buf;
    }

    fn sizeFn(ptr: *anyopaque) Error!u64 {
        const self: *RealStorage = @ptrCast(@alignCast(ptr));
        return self.end;
    }
};
