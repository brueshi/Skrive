//! Recovery: the newest trustworthy snapshot, plus the log tail after it.
//!
//! This is the whole point of the framing and the store. Everything the fault
//! harness asserts, it asserts about the result of this function.

const std = @import("std");
const log_mod = @import("log.zig");
const snapshot_mod = @import("snapshot.zig");

const Replay = log_mod.Replay;
const SnapshotStore = snapshot_mod.SnapshotStore;
const Error = @import("storage.zig").Error;

pub const Recovery = struct {
    /// The snapshot recovery stood on, or null if it fell all the way back to
    /// replaying the whole log.
    snapshot_index: ?u64,
    /// Owned. The snapshot's payload, or null when no snapshot was used.
    snapshot_payload: ?[]u8,
    /// Where log replay began.
    log_offset: u64,
    /// How many stored snapshots were rejected before one was trusted. Zero
    /// on a healthy store; non-zero is the fallback path having done its job.
    snapshots_rejected: usize,
    replay: Replay,

    pub fn deinit(self: *Recovery, gpa: std.mem.Allocator) void {
        if (self.snapshot_payload) |p| gpa.free(p);
        self.replay.deinit(gpa);
        self.* = undefined;
    }
};

/// Recover from `log_image` and `store`.
///
/// Walks snapshots newest-first and takes the first one that is *usable*,
/// which is a stronger test than "decodes": a snapshot whose recorded log
/// offset runs past the log we actually have is internally consistent and
/// still wrong, so it is rejected too. That is the case the fault model calls
/// out — a valid snapshot with an invalid log position — and it is the one a
/// checksum alone will never catch.
pub fn recover(
    gpa: std.mem.Allocator,
    log_image: []const u8,
    store: SnapshotStore,
) Error!Recovery {
    const indices = try store.list(gpa);
    defer gpa.free(indices);

    var rejected: usize = 0;

    var i = indices.len;
    while (i > 0) {
        i -= 1;
        const index = indices[i];

        const raw = (try store.read(gpa, index)) orelse continue;
        // The decoded payload borrows from `raw`, so it is copied out before
        // this frees it. Snapshots are read once at startup; the copy costs
        // nothing worth keeping a lifetime puzzle for.
        defer gpa.free(raw);

        const snap = snapshot_mod.decode(raw) orelse {
            rejected += 1;
            continue;
        };
        if (snap.log_offset > log_image.len) {
            rejected += 1;
            continue;
        }

        const payload = try gpa.alloc(u8, snap.payload.len);
        errdefer gpa.free(payload);
        @memcpy(payload, snap.payload);

        const offset: usize = @intCast(snap.log_offset);
        var r = try log_mod.replay(gpa, log_image[offset..]);
        errdefer r.deinit(gpa);

        return .{
            .snapshot_index = index,
            .snapshot_payload = payload,
            .log_offset = snap.log_offset,
            .snapshots_rejected = rejected,
            .replay = r,
        };
    }

    return .{
        .snapshot_index = null,
        .snapshot_payload = null,
        .log_offset = 0,
        .snapshots_rejected = rejected,
        .replay = try log_mod.replay(gpa, log_image),
    };
}
