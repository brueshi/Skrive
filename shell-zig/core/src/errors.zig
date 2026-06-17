//! Envelope error codes and the single subsystem-error -> code mapping.
//!
//! The closed set mirrors `SKRIVE_ERROR_CODES` in
//! `shared/src/ipc-contracts.ts`. Hosts and core never invent codes ad
//! hoc; adding one is a contract change that lands there first and here
//! second.
//!
//! Convention (master plan, Zig-core conventions): each subsystem owns an
//! error set (`FsError`, `ProjectError`, ...) and is mapped to an
//! `ErrorCode` in exactly one place — `codeFor` below. Stage 2.1 only
//! needs the envelope-level codes the dispatcher emits directly; 2.2+
//! extends `codeFor` as each subsystem's handlers land.

const std = @import("std");

pub const ErrorCode = enum {
    bad_envelope,
    unknown_command,
    payload_too_large,
    invalid_payload,
    path_escape,
    not_found,
    already_exists,
    no_project,
    io_error,
    git_error,
    internal,

    /// The SCREAMING_SNAKE wire string carried in the error envelope. It
    /// must match the closed set in `ipc-contracts.ts` byte-for-byte —
    /// parity is asserted on `error.code`.
    pub fn wire(self: ErrorCode) []const u8 {
        return switch (self) {
            .bad_envelope => "BAD_ENVELOPE",
            .unknown_command => "UNKNOWN_COMMAND",
            .payload_too_large => "PAYLOAD_TOO_LARGE",
            .invalid_payload => "INVALID_PAYLOAD",
            .path_escape => "PATH_ESCAPE",
            .not_found => "NOT_FOUND",
            .already_exists => "ALREADY_EXISTS",
            .no_project => "NO_PROJECT",
            .io_error => "IO_ERROR",
            .git_error => "GIT_ERROR",
            .internal => "INTERNAL",
        };
    }

    /// A short, static human message. Intentionally constant: parity
    /// normalizes `message` away, and the delivery rule forbids
    /// interpolating attacker-influenced content (a `cmd` value, a path)
    /// into the response unescaped, so no code's message embeds request
    /// data.
    pub fn message(self: ErrorCode) []const u8 {
        return switch (self) {
            .bad_envelope => "malformed request envelope",
            .unknown_command => "command not implemented",
            .payload_too_large => "request exceeds maximum size",
            .invalid_payload => "invalid command payload",
            .path_escape => "path escapes project root",
            .not_found => "not found",
            .already_exists => "already exists",
            .no_project => "no open project",
            .io_error => "filesystem operation failed",
            .git_error => "git operation failed",
            .internal => "core failure",
        };
    }
};

/// Map a subsystem error to its envelope code. The dispatcher calls this
/// for anything a handler throws. Extended per subsystem as
/// fs/project/persistence land (2.2+); anything unmapped is `INTERNAL` by
/// contract — an `INTERNAL` surfacing in parity is a missing mapping
/// here, not a renderer concern.
pub fn codeFor(err: anyerror) ErrorCode {
    return switch (err) {
        // fs subsystem (2.2). Zig error tags are global, so these match
        // `FsError` in fs.zig without importing it (no circular import).
        error.PathEscape => .path_escape,
        error.InvalidPayload => .invalid_payload,
        error.AlreadyExists => .already_exists,
        error.IoFailure => .io_error,
        error.OutOfMemory => .internal,
        else => .internal,
    };
}

test "wire strings match the closed contract set" {
    try std.testing.expectEqualStrings("BAD_ENVELOPE", ErrorCode.bad_envelope.wire());
    try std.testing.expectEqualStrings("UNKNOWN_COMMAND", ErrorCode.unknown_command.wire());
    try std.testing.expectEqualStrings("PAYLOAD_TOO_LARGE", ErrorCode.payload_too_large.wire());
    try std.testing.expectEqualStrings("PATH_ESCAPE", ErrorCode.path_escape.wire());
    try std.testing.expectEqualStrings("INTERNAL", ErrorCode.internal.wire());
}

test "codeFor maps subsystem errors and defaults the rest to INTERNAL" {
    try std.testing.expectEqual(ErrorCode.path_escape, codeFor(error.PathEscape));
    try std.testing.expectEqual(ErrorCode.invalid_payload, codeFor(error.InvalidPayload));
    try std.testing.expectEqual(ErrorCode.already_exists, codeFor(error.AlreadyExists));
    try std.testing.expectEqual(ErrorCode.io_error, codeFor(error.IoFailure));
    try std.testing.expectEqual(ErrorCode.internal, codeFor(error.OutOfMemory));
    try std.testing.expectEqual(ErrorCode.internal, codeFor(error.SomethingElse));
}
