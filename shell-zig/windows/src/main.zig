//! Skrive Windows host entry point.
//!
//! Thin: build the App (window + Zig core + WebView2) and pump the message
//! loop. Everything else lives in app.zig (orchestration), webview2.zig (the
//! hand-declared COM ABI), handlers.zig (the COM callback objects), win32.zig
//! (the Win32 surface), and jsescape.zig (the delivery-rule escaper).
//!
//! GUI subsystem (build.zig sets `exe.subsystem = .Windows`), so no console
//! flashes on launch. Zig's WinMainCRTStartup shim still calls this `main`.
//! Because there is no console, a startup failure can't print to stderr — it
//! surfaces via a MessageBox instead (parity with the macOS host's
//! presentFatal NSAlert). In-flight diagnostics still go to skrive-diag.log
//! in dev builds (diag.zig).

const std = @import("std");
const win32 = @import("win32.zig");
const app_mod = @import("app.zig");
const App = app_mod.App;

/// How long a forwarding instance waits for the running one's window to exist.
/// The race is real but narrow: double-clicking a second file while the first
/// instance is still starting up. Waiting beats the alternatives — exiting
/// immediately silently loses the file, and starting a second instance fights
/// over the WebView2 user-data folder, which is locked to one process.
const FORWARD_WAIT_MS: u64 = 5000;
const FORWARD_POLL_MS: u64 = 50;

pub fn main() !void {
    const gpa = std.heap.c_allocator;

    // Files Explorer (or a command line) asked us to open. Read before the
    // single-instance check, because the second instance's whole job is to
    // hand these to the first one. Owned strings in an owned slice.
    const open_paths = collectOpenPaths(gpa);

    // Single instance. A second launch forwards its file arguments to the
    // running window and exits, so a double-click lands in the app the user
    // already has open rather than starting a rival copy.
    const mutex_name = std.unicode.utf8ToUtf16LeStringLiteral("Local\\Skrive-SingleInstance");
    _ = win32.CreateMutexW(null, 0, mutex_name);
    if (win32.GetLastError() == win32.ERROR_ALREADY_EXISTS) {
        defer {
            for (open_paths) |p| gpa.free(p);
            gpa.free(open_paths);
        }
        forwardOpenPaths(gpa, open_paths);
        return;
    }

    const app = App.create(gpa) catch |err| {
        for (open_paths) |p| gpa.free(p);
        gpa.free(open_paths);
        fatal("Skrive failed to start: {s}", .{@errorName(err)});
        return err;
    };
    // deliverOpenPaths takes ownership of the strings; only the slice holding
    // them is ours to release.
    app.deliverOpenPaths(open_paths);
    gpa.free(open_paths);
    app.run();
}

/// The file arguments on this process's command line, as owned WTF-8 strings.
/// argv[0] (the exe) is skipped, as is anything that isn't an existing file —
/// a stray flag must not be mistaken for a document.
fn collectOpenPaths(gpa: std.mem.Allocator) [][]const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var count: i32 = 0;
    const argv = win32.CommandLineToArgvW(win32.GetCommandLineW(), &count) orelse return &.{};
    defer _ = win32.LocalFree(@ptrCast(argv));
    if (count < 2) return &.{};

    var i: usize = 1; // argv[0] is the exe
    while (i < @as(usize, @intCast(count))) : (i += 1) {
        const arg_w = std.mem.span(argv[i]);
        if (arg_w.len == 0 or arg_w[0] == '-' or arg_w[0] == '/') continue;
        // Must name an existing FILE. Tested on the wide string, before any
        // conversion: it rejects a mistyped flag and a directory in one call,
        // and the renderer only ever wants documents.
        const attrs = win32.GetFileAttributesW(argv[i]);
        if (attrs == win32.INVALID_FILE_ATTRIBUTES) continue;
        if (attrs & win32.FILE_ATTRIBUTE_DIRECTORY != 0) continue;
        const arg = std.unicode.utf16LeToUtf8Alloc(gpa, arg_w) catch continue;
        out.append(gpa, arg) catch {
            gpa.free(arg);
            continue;
        };
    }
    return out.toOwnedSlice(gpa) catch &.{};
}

/// Hand our file arguments to the already-running instance over WM_COPYDATA,
/// newline-separated (a path cannot contain a newline on Windows).
fn forwardOpenPaths(gpa: std.mem.Allocator, items: []const []const u8) void {
    if (items.len == 0) return;

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(gpa);
    for (items, 0..) |item, i| {
        if (i > 0) buf.append(gpa, '\n') catch return;
        buf.appendSlice(gpa, item) catch return;
    }
    if (buf.items.len == 0) return;

    const hwnd = waitForWindow() orelse return;
    // Let the running instance take the foreground: without this the OS
    // foreground lock can leave the window raised but behind ours.
    _ = win32.AllowSetForegroundWindow(win32.ASFW_ANY);
    var cds = win32.COPYDATASTRUCT{
        .dwData = app_mod.COPYDATA_OPEN_PATHS,
        .cbData = @intCast(buf.items.len),
        .lpData = @ptrCast(buf.items.ptr),
    };
    _ = win32.SendMessageW(hwnd, win32.WM_COPYDATA, 0, @bitCast(@intFromPtr(&cds)));
}

/// The running instance's window, waiting out a startup race (see
/// FORWARD_WAIT_MS). Null when it never appeared.
fn waitForWindow() ?win32.HWND {
    var waited: u64 = 0;
    while (true) {
        if (win32.FindWindowW(app_mod.CLASS_NAME, null)) |hwnd| return hwnd;
        if (waited >= FORWARD_WAIT_MS) return null;
        win32.Sleep(@intCast(FORWARD_POLL_MS));
        waited += FORWARD_POLL_MS;
    }
}

/// Report a fatal startup error in a modal box (stderr is invisible under the
/// GUI subsystem). Best-effort: if formatting or the UTF-16 conversion fails,
/// the process still exits with the propagated error.
fn fatal(comptime fmt: []const u8, args: anytype) void {
    var buf: [512]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, fmt, args) catch "Skrive failed to start.";
    var wbuf: [512]u16 = undefined;
    const n = std.unicode.utf8ToUtf16Le(&wbuf, msg) catch return;
    wbuf[n] = 0;
    const caption = std.unicode.utf8ToUtf16LeStringLiteral("Skrive");
    _ = win32.MessageBoxW(null, wbuf[0..n :0].ptr, caption, win32.MB_OK | win32.MB_ICONERROR);
}
