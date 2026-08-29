//! Test aggregator. Runs headless via `zig build test`.
//!
//! One file per subject; importing them here is what pulls their tests into
//! the binary.

test {
    _ = @import("seam_test.zig");
    _ = @import("log_test.zig");
    _ = @import("folio_test.zig");
    _ = @import("corpus_test.zig");
    _ = @import("index_test.zig");
}
