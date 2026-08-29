//! The clock seam.
//!
//! Time is injected for the same reason I/O is: the engine stamps records and
//! decides snapshot cadence from it, and a replay that consults the wall
//! clock is not deterministic and therefore not a proof of anything. The
//! simulated clock only moves when a test moves it.
//!
//! Zig 0.16 already treats wall time as an `std.Io` capability, so the real
//! implementation delegates there. This seam stays narrower than `std.Io` on
//! purpose — one method, the only question the engine ever asks of time.

const std = @import("std");

pub const Clock = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        nowMillis: *const fn (ptr: *anyopaque) i64,
    };

    pub inline fn nowMillis(self: Clock) i64 {
        return self.vtable.nowMillis(self.ptr);
    }
};

pub const RealClock = struct {
    io: std.Io,

    pub fn init(io: std.Io) RealClock {
        return .{ .io = io };
    }

    pub fn clock(self: *RealClock) Clock {
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: Clock.VTable = .{ .nowMillis = nowMillisFn };

    fn nowMillisFn(ptr: *anyopaque) i64 {
        const self: *RealClock = @ptrCast(@alignCast(ptr));
        return std.Io.Timestamp.now(self.io, .real).toMilliseconds();
    }
};

pub const SimClock = struct {
    millis: i64 = 0,

    pub fn clock(self: *SimClock) Clock {
        return .{ .ptr = self, .vtable = &vtable };
    }

    pub fn advance(self: *SimClock, by_millis: i64) void {
        self.millis += by_millis;
    }

    const vtable: Clock.VTable = .{ .nowMillis = nowMillisFn };

    fn nowMillisFn(ptr: *anyopaque) i64 {
        const self: *SimClock = @ptrCast(@alignCast(ptr));
        return self.millis;
    }
};
