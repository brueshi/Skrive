//! zig-data-engine — the public surface of the lab.
//!
//! Stage 1 establishes the seams every later stage is written against: all
//! durable I/O behind `Storage`, all time behind `Clock`. The engine itself
//! arrives on top of them, so it is testable under simulated faults from its
//! first commit.

pub const FaultClass = @import("fault.zig").FaultClass;

const storage = @import("storage.zig");
pub const Storage = storage.Storage;
pub const StorageError = storage.Error;
pub const CrashError = storage.CrashError;
pub const Fault = storage.Fault;

pub const RealStorage = @import("real_storage.zig").RealStorage;
pub const SimStorage = @import("sim_storage.zig").SimStorage;

const clock = @import("clock.zig");
pub const Clock = clock.Clock;
pub const RealClock = clock.RealClock;
pub const SimClock = clock.SimClock;
