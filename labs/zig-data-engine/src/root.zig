//! zig-data-engine — the public surface of the lab.
//!
//! Stage 1 established the seams: all durable I/O behind `Storage`, all time
//! behind `Clock`. Stage 2 puts the durable log on top of them — framing,
//! append, replay, snapshots, and recovery — which is the code that can lose
//! data and therefore the code the fault harness exists for.

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

const log = @import("log.zig");
pub const Log = log.Log;
pub const Record = log.Record;
pub const RecordType = log.RecordType;
pub const Replay = log.Replay;
pub const StopReason = log.StopReason;
pub const replay = log.replay;
pub const header_len = log.header_len;
pub const max_payload_len = log.max_payload_len;

const snapshot = @import("snapshot.zig");
pub const Snapshot = snapshot.Snapshot;
pub const SnapshotStore = snapshot.SnapshotStore;
pub const SimSnapshotStore = snapshot.SimSnapshotStore;
pub const encodeSnapshot = snapshot.encode;
pub const decodeSnapshot = snapshot.decode;

const recover_mod = @import("recover.zig");
pub const Recovery = recover_mod.Recovery;
pub const recover = recover_mod.recover;
