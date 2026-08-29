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

pub const folio = @import("folio.zig");
pub const parseFolio = @import("folio_parse.zig").parseDocument;
pub const parseFolioBlock = @import("folio_parse.zig").parseBlock;
pub const FolioParseError = @import("folio_parse.zig").ParseError;
pub const writeFolio = @import("folio_write.zig").writeDocument;
pub const writeFolioBlock = @import("folio_write.zig").writeBlock;

pub const tokenize = @import("tokenize.zig");
pub const BlockKind = tokenize.BlockKind;
pub const harvest = tokenize.harvest;

const index_mod = @import("index.zig");
pub const Index = index_mod.Index;
pub const TermId = index_mod.TermId;
pub const BlockRef = index_mod.BlockRef;
pub const Posting = index_mod.Posting;
pub const BlockInfo = index_mod.BlockInfo;
pub const Footprint = index_mod.Index.Footprint;

const search_mod = @import("search.zig");
pub const Hit = search_mod.Hit;
pub const Query = search_mod.Query;
pub const parseQuery = search_mod.parseQuery;
pub const runQuery = search_mod.run;

const index_snapshot = @import("index_snapshot.zig");
pub const saveIndex = index_snapshot.save;
pub const loadIndex = index_snapshot.load;
