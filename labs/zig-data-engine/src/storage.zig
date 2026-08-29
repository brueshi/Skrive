//! The storage seam.
//!
//! Every byte the engine durably writes goes through this interface, and
//! nothing below it calls the filesystem directly. That is not a testing
//! convenience — it is the precondition for injecting a crash at every byte
//! offset of an in-flight append, and it is the one thing in this lab that
//! cannot be retrofitted once a storage engine is written on top of it.
//!
//! **Why a narrow bespoke seam rather than `std.Io`.** Zig 0.16's `std.Io` is
//! already an injected I/O interface, and `shell-zig/core` threads one. It is
//! the wrong seam for this job on three counts. The faults that matter here
//! are byte-image properties of a log — truncate at N, tear a sector, flip a
//! bit, lose the unsynced tail — not syscall-level behaviors, so injecting at
//! `std.Io` granularity means reconstructing the byte image anyway. The
//! engine plan requires the hand-rolled log and the LMDB fallback to present
//! the same API upward so the substrate can be swapped, and `std.Io` cannot
//! express "LMDB is underneath". And the governing discipline is to shrink
//! the dangerous surface until it can be exhaustively tested: four operations
//! can be, a general I/O interface cannot.
//!
//! `RealStorage` is nevertheless implemented on top of `std.Io`, so the real
//! path stays idiomatic and matches the shell core's convention.

const std = @import("std");
const FaultClass = @import("fault.zig").FaultClass;

/// Closed and deliberately small. Callers map their own failures into it so
/// the engine never sees a raw filesystem error.
pub const Error = error{
    WriteFailed,
    ReadFailed,
    SyncFailed,
    OutOfMemory,
};

/// The four operations an append-only log needs. Snapshots add an atomic
/// whole-file write in stage 2; extending the vtable is not a retrofit of the
/// seam, which is what had to exist first.
pub const Storage = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        append: *const fn (ptr: *anyopaque, bytes: []const u8) Error!void,
        sync: *const fn (ptr: *anyopaque) Error!void,
        readAll: *const fn (ptr: *anyopaque, gpa: std.mem.Allocator) Error![]u8,
        size: *const fn (ptr: *anyopaque) Error!u64,
    };

    /// Write to the end of the log. Durable only after `sync` returns.
    pub inline fn append(self: Storage, bytes: []const u8) Error!void {
        return self.vtable.append(self.ptr, bytes);
    }

    /// The fsync barrier. Everything appended before this call survives a
    /// crash; everything after it may not.
    pub inline fn sync(self: Storage) Error!void {
        return self.vtable.sync(self.ptr);
    }

    /// The whole log, caller-owned.
    pub inline fn readAll(self: Storage, gpa: std.mem.Allocator) Error![]u8 {
        return self.vtable.readAll(self.ptr, gpa);
    }

    pub inline fn size(self: Storage) Error!u64 {
        return self.vtable.size(self.ptr);
    }
};

/// A fault to inject, keyed by the class it belongs to so the tag set and
/// `FaultClass` cannot drift. Injection sites switch exhaustively, which is
/// what makes adding a class a compile error rather than a silent gap.
///
/// Parameters describe the physical outcome, not the cause: what a reader
/// finds on disk afterward.
pub const Fault = union(FaultClass) {
    /// The file simply ends. `keep_bytes` survive; the rest never happened.
    truncation: struct { keep_bytes: u64 },
    /// One sector never reached the platter. The file keeps its length and
    /// the lost span reads back as zeroes, so survivors are not a prefix.
    torn_sector: struct { sector_size: u32, drop_index: u32 },
    /// One byte inside a structurally intact record is altered.
    bit_flip: struct { at_byte: u64, mask: u8 },
    /// Page-cache loss: pages written since the last fsync vanish in any
    /// subset. Bit i of `survivor_mask` set means pending page i reached
    /// disk. Lost pages read back as zeroes, not as a shorter file.
    lost_unsynced_tail: struct { page_size: u32, survivor_mask: u64 },
    /// Meaningful only against a snapshot file, which arrives in stage 2.
    corrupt_snapshot: void,
};

/// `Error` plus the one failure that is a statement about the storage rather
/// than about I/O: there is no snapshot here to corrupt.
pub const CrashError = Error || error{NoSnapshot};
