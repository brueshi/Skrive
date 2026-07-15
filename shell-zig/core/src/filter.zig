//! Shared path-filter predicates: the noise-dir skip list and the markdown
//! extension test, copied verbatim from `shell/src/lib/snapshot.ts`. A leaf
//! module (no core dependencies) so both the project snapshot walker and the
//! watcher's chokidar-parity filter use one source of truth without an import
//! cycle.

const std = @import("std");

/// NOISE_DIRS from snapshot.ts — directories the scan and the watcher both
/// skip entirely.
pub const NOISE_DIRS = [_][]const u8{
    "node_modules", "target",      "dist",  "build", "__pycache__", "venv",
    ".git",         ".svelte-kit", ".next", "out",   ".DS_Store",
};

pub fn isNoiseDir(name: []const u8) bool {
    for (NOISE_DIRS) |d| {
        if (std.mem.eql(u8, d, name)) return true;
    }
    return false;
}

fn endsWithIgnoreCase(s: []const u8, suffix: []const u8) bool {
    if (s.len < suffix.len) return false;
    return std.ascii.eqlIgnoreCase(s[s.len - suffix.len ..], suffix);
}

/// MARKDOWN_EXT from snapshot.ts: `.md` / `.markdown`, case-insensitive.
pub fn isMarkdown(name: []const u8) bool {
    return endsWithIgnoreCase(name, ".md") or endsWithIgnoreCase(name, ".markdown");
}

/// `.folio`, case-insensitive: Skrive's native rich format.
pub fn isFolio(name: []const u8) bool {
    return endsWithIgnoreCase(name, ".folio");
}

/// Files whose full body the snapshot reads: Markdown (frontmatter, links, lint)
/// and `.folio` (the native format, whose body carries the tag index). Other
/// openable files (`.txt`, `.html`) and assets stay body-less — the renderer
/// fetches them on demand.
pub fn withBody(name: []const u8) bool {
    return isMarkdown(name) or isFolio(name);
}

test "isMarkdown, isFolio, withBody, and isNoiseDir match the oracle rules" {
    try std.testing.expect(isMarkdown("a.md"));
    try std.testing.expect(isMarkdown("A.MARKDOWN"));
    try std.testing.expect(!isMarkdown("a.png"));
    try std.testing.expect(!isMarkdown("README"));
    try std.testing.expect(isFolio("doc.folio"));
    try std.testing.expect(isFolio("DOC.FOLIO"));
    try std.testing.expect(!isFolio("doc.md"));
    try std.testing.expect(withBody("a.md"));
    try std.testing.expect(withBody("doc.folio"));
    try std.testing.expect(!withBody("a.png"));
    try std.testing.expect(!withBody("notes.txt"));
    try std.testing.expect(isNoiseDir("node_modules"));
    try std.testing.expect(isNoiseDir(".git"));
    try std.testing.expect(!isNoiseDir("notes"));
}
