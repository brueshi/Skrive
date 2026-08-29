//! zig-data-engine — the public surface of the lab.
//!
//! Stage 0 establishes the build and the fault model. The engine itself
//! arrives behind injected seams (Stage 1) so that every later stage is
//! testable under simulated faults from its first commit.

pub const FaultClass = @import("fault.zig").FaultClass;
