//! The fault model as a typed enum. The prose spec — recovery contract and
//! injection strategy per class — is `docs/fault-model.md`, and the two are
//! kept in step deliberately.
//!
//! This exists as code, not only prose, because the simulated storage layer
//! switches exhaustively over it: adding a fault class is a compile error
//! until every injection site handles it. That is the property that keeps
//! "green under injected faults" from quietly narrowing as the engine grows.

const std = @import("std");

/// The disk faults the durability harness injects.
pub const FaultClass = enum {
    /// The log ends at an arbitrary byte offset mid-append.
    truncation,
    /// A partial sector reaches disk. Surviving bytes need not be a prefix.
    torn_sector,
    /// A byte inside a structurally valid record is corrupted.
    bit_flip,
    /// Writes issued after the last fsync vanish, in any subset.
    lost_unsynced_tail,
    /// The newest snapshot fails validation.
    corrupt_snapshot,

    /// One line per class, for harness output and failure messages. The
    /// switch is exhaustive on purpose.
    pub fn description(self: FaultClass) []const u8 {
        return switch (self) {
            .truncation => "log ends at an arbitrary byte offset mid-append",
            .torn_sector => "a partial sector reaches disk; survivors need not be a prefix",
            .bit_flip => "a byte inside a structurally valid record is corrupted",
            .lost_unsynced_tail => "writes since the last fsync vanish, in any subset",
            .corrupt_snapshot => "the newest snapshot fails validation",
        };
    }
};
