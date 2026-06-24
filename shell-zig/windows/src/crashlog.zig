//! Local, privacy-preserving crash + diagnostics logging (Stage 6.5) — the
//! Windows twin of the macOS host's CrashLog.swift. Everything is written to
//! %APPDATA%\Skrive\crashes and NEVER uploaded; the user grabs the folder by
//! hand via Settings -> "Reveal diagnostics" and sends it in. This matches
//! Skrive's no-telemetry posture and brings field crashes to the (Mac-based)
//! dev without a reproduction.
//!
//! Three native sources land here, mirroring the macOS handlers:
//!   1. Unhandled native exceptions (incl. Zig host/core panics, which @trap to
//!      an illegal-instruction exception) -> SetUnhandledExceptionFilter writes
//!      a minidump (`native-crash.dmp`) + a breadcrumb. This is the exact
//!      parity of the mac signal handler, where a core panic traps to SIGABRT.
//!   2. Renderer JS errors (window.onerror / unhandledrejection) -> the
//!      sandboxed renderer can't write files, so it forwards them over the
//!      `log:append` command and the host appends to `renderer.log`.
//!   3. WebView2 content-process death -> a breadcrumb via the ProcessFailed
//!      handler (app.zig), which then reloads the renderer to recover.
//!
//! Windows already writes its own crash report via WER/DiagnosticReports; the
//! exception filter adds a Skrive-owned minidump + breadcrumb and returns
//! EXCEPTION_CONTINUE_SEARCH so that default WER handling still runs.

const std = @import("std");
const win32 = @import("win32.zig");
const paths = @import("paths.zig");
const host_cmds = @import("host_cmds.zig");

// Wide, NUL-terminated paths resolved once in install() (before any other
// thread exists) and only read inside the exception filter, which must not
// allocate or call the std/libc machinery. Externally synchronized by program
// order — install() runs first on the main thread — so the unprotected globals
// are sound. Allocated with c_allocator and intentionally leaked (process
// lifetime), mirroring the macOS host's strdup'd C strings.
var dump_path_w: ?[*:0]const u16 = null;
var native_log_w: ?[*:0]const u16 = null;

/// Install the native crash handler. Call as early as possible (before the
/// window/webview and any worker thread) so a crash during startup is still
/// captured. Best-effort: a failure to resolve the crashes dir leaves the
/// handler uninstalled rather than aborting startup.
pub fn install(gpa: std.mem.Allocator) void {
    const dir = crashesDir(gpa) catch return;
    defer gpa.free(dir);

    dump_path_w = stashWide(gpa, dir, "native-crash.dmp");
    native_log_w = stashWide(gpa, dir, "native-crash.log");

    _ = win32.SetUnhandledExceptionFilter(crashFilter);
}

/// Top-level exception filter. Async-unsafe work is avoided: only Win32 calls
/// and stack-buffer formatting (no heap, no libc buffering). Writes a minidump
/// + a breadcrumb, then lets default WER handling proceed.
fn crashFilter(info: ?*anyopaque) callconv(win32.WINAPI) win32.LONG {
    if (native_log_w) |lp| {
        var st: win32.SYSTEMTIME = undefined;
        win32.GetLocalTime(&st);
        var buf: [256]u8 = undefined;
        const line = std.fmt.bufPrint(
            &buf,
            "[{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}] Skrive host crash (unhandled exception); minidump: native-crash.dmp\n",
            .{ st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond },
        ) catch "";
        appendWide(lp, line);
    }

    if (dump_path_w) |dp| {
        const h = win32.CreateFileW(dp, win32.GENERIC_WRITE, 0, null, win32.CREATE_ALWAYS, win32.FILE_ATTRIBUTE_NORMAL, null);
        if (h != win32.INVALID_HANDLE_VALUE) {
            var exinfo = win32.MINIDUMP_EXCEPTION_INFORMATION{
                .ThreadId = win32.GetCurrentThreadId(),
                .ExceptionPointers = info,
                .ClientPointers = 0,
            };
            _ = win32.MiniDumpWriteDump(
                win32.GetCurrentProcess(),
                win32.GetCurrentProcessId(),
                h,
                win32.MiniDumpNormal,
                &exinfo,
                null,
                null,
            );
            _ = win32.CloseHandle(h);
        }
    }

    return win32.EXCEPTION_CONTINUE_SEARCH;
}

/// Append a renderer-diagnostics line (from `log:append`). Normal UI-thread
/// context, so the allocator is fair game; renderer errors are rare.
pub fn appendRenderer(gpa: std.mem.Allocator, line: []const u8) void {
    const dir = crashesDir(gpa) catch return;
    defer gpa.free(dir);
    const path = std.fs.path.join(gpa, &.{ dir, "renderer.log" }) catch return;
    defer gpa.free(path);
    appendUtf8(gpa, path, "{s} {s}\n", .{ timestamp(), line });
}

/// WebView2 content-process death — not a host crash (no minidump), so it gets
/// its own breadcrumb. The host reloads the renderer to recover (app.zig).
pub fn logWebviewTermination(gpa: std.mem.Allocator) void {
    const dir = crashesDir(gpa) catch return;
    defer gpa.free(dir);
    const path = std.fs.path.join(gpa, &.{ dir, "native-crash.log" }) catch return;
    defer gpa.free(path);
    appendUtf8(gpa, path, "{s} Skrive webview: content process terminated; reloading the renderer.\n", .{timestamp()});
}

/// Open the crashes folder in Explorer (Settings -> "Reveal diagnostics").
pub fn reveal(gpa: std.mem.Allocator) void {
    const dir = crashesDir(gpa) catch return;
    defer gpa.free(dir);
    _ = host_cmds.reveal(gpa, dir);
}

// ---- helpers --------------------------------------------------------------

/// %APPDATA%\Skrive\crashes, created if missing. Caller owns the result.
fn crashesDir(gpa: std.mem.Allocator) ![]u8 {
    const app_data = try paths.appDataDir(gpa);
    defer gpa.free(app_data);
    const dir = try std.fs.path.join(gpa, &.{ app_data, "crashes" });
    errdefer gpa.free(dir);
    const dir_w = try std.unicode.utf8ToUtf16LeAllocZ(gpa, dir);
    defer gpa.free(dir_w);
    _ = win32.CreateDirectoryW(dir_w.ptr, null); // ignore "already exists"
    return dir;
}

/// Build `dir\name`, convert to a wide NUL-terminated string, and leak it for
/// the process lifetime (the exception filter holds the pointer). Returns null
/// on any failure (the filter then skips that artifact).
fn stashWide(gpa: std.mem.Allocator, dir: []const u8, name: []const u8) ?[*:0]const u16 {
    const path = std.fs.path.join(gpa, &.{ dir, name }) catch return null;
    defer gpa.free(path);
    const wide = std.unicode.utf8ToUtf16LeAllocZ(std.heap.c_allocator, path) catch return null;
    return wide.ptr; // intentionally leaked: lives for the whole process.
}

/// Append a UTF-8 line to `path` (created if absent) using raw Win32, so the
/// renderer-log and breadcrumb paths share one mechanism. Best-effort.
fn appendUtf8(gpa: std.mem.Allocator, path: []const u8, comptime fmt: []const u8, args: anytype) void {
    const path_w = std.unicode.utf8ToUtf16LeAllocZ(gpa, path) catch return;
    defer gpa.free(path_w);
    const content = std.fmt.allocPrint(gpa, fmt, args) catch return;
    defer gpa.free(content);
    appendWide(path_w.ptr, content);
}

/// Append raw bytes to the file at `path_w`. Opened with FILE_APPEND_DATA so the
/// write always lands at end-of-file with no seek; safe to call from the
/// exception filter (no allocator, no buffering). Best-effort.
fn appendWide(path_w: [*:0]const u16, bytes: []const u8) void {
    if (bytes.len == 0) return;
    const h = win32.CreateFileW(
        path_w,
        win32.FILE_APPEND_DATA,
        win32.FILE_SHARE_READ | win32.FILE_SHARE_WRITE,
        null,
        win32.OPEN_ALWAYS,
        win32.FILE_ATTRIBUTE_NORMAL,
        null,
    );
    if (h == win32.INVALID_HANDLE_VALUE) return;
    defer _ = win32.CloseHandle(h);
    var written: u32 = 0;
    _ = win32.WriteFile(h, bytes.ptr, @intCast(bytes.len), &written, null);
}

/// ISO-8601-ish local timestamp `[YYYY-MM-DDTHH:MM:SS]` for renderer/webview
/// lines (normal context only — uses a static buffer, single-threaded callers).
fn timestamp() []const u8 {
    const S = struct {
        var buf: [32]u8 = undefined;
    };
    var st: win32.SYSTEMTIME = undefined;
    win32.GetLocalTime(&st);
    return std.fmt.bufPrint(
        &S.buf,
        "[{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}]",
        .{ st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond },
    ) catch "[?]";
}
