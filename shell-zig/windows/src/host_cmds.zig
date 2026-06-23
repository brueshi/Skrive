//! Windows implementations of the host-owned commands, mirroring the macOS
//! CoreBridge handlers. Flat Win32 where possible; only the folder picker
//! (shell.zig) needs COM.

const std = @import("std");
const win32 = @import("win32.zig");
const shell = @import("shell.zig");

/// Open an external URL in the default handler, gated by the Part I scheme
/// allowlist (http/https/mailto). A disallowed scheme is a silent no-op.
pub fn openExternal(gpa: std.mem.Allocator, url: []const u8) void {
    const allowed = std.mem.startsWith(u8, url, "http://") or
        std.mem.startsWith(u8, url, "https://") or
        std.mem.startsWith(u8, url, "mailto:");
    if (!allowed) return;
    const url_w = std.unicode.utf8ToUtf16LeAllocZ(gpa, url) catch return;
    defer gpa.free(url_w);
    const verb = std.unicode.utf8ToUtf16LeStringLiteral("open");
    _ = win32.ShellExecuteW(null, verb, url_w.ptr, null, null, win32.SW_SHOWNORMAL);
}

/// Open a folder in Explorer (persistence:revealUserData).
pub fn reveal(gpa: std.mem.Allocator, path: []const u8) bool {
    const path_w = std.unicode.utf8ToUtf16LeAllocZ(gpa, path) catch return false;
    defer gpa.free(path_w);
    const verb = std.unicode.utf8ToUtf16LeStringLiteral("open");
    const rc = win32.ShellExecuteW(null, verb, path_w.ptr, null, null, win32.SW_SHOWNORMAL);
    return @intFromPtr(rc) > 32; // ShellExecute success convention
}

/// Move a path to the Recycle Bin (fs:trash, via the host: channel).
pub fn trash(gpa: std.mem.Allocator, path: []const u8) bool {
    const path_w = std.unicode.utf8ToUtf16LeAlloc(gpa, path) catch return false;
    defer gpa.free(path_w);
    // pFrom must be double-NUL-terminated.
    const buf = gpa.alloc(u16, path_w.len + 2) catch return false;
    defer gpa.free(buf);
    @memcpy(buf[0..path_w.len], path_w);
    buf[path_w.len] = 0;
    buf[path_w.len + 1] = 0;
    var op = win32.SHFILEOPSTRUCTW{
        .hwnd = null,
        .wFunc = win32.FO_DELETE,
        .pFrom = @ptrCast(buf.ptr),
        .pTo = null,
        .fFlags = win32.FOF_ALLOWUNDO | win32.FOF_NOCONFIRMATION | win32.FOF_SILENT | win32.FOF_NOERRORUI,
        .fAnyOperationsAborted = 0,
        .hNameMappings = null,
        .lpszProgressTitle = null,
    };
    return win32.SHFileOperationW(&op) == 0;
}

/// Folder picker (project:openDialog).
pub fn pickFolder(gpa: std.mem.Allocator, owner: ?win32.HWND) ?[]u8 {
    return shell.pickFolder(gpa, owner);
}

// ---- clipboard ------------------------------------------------------------

/// Copy `bytes` (already including any trailing NUL) into a moveable global
/// and hand it to the clipboard under `format`. The system takes ownership on
/// success. Returns whether it was set.
fn setClipboard(format: u32, bytes: []const u8) bool {
    const h = win32.GlobalAlloc(win32.GMEM_MOVEABLE, bytes.len) orelse return false;
    const dst = win32.GlobalLock(h) orelse return false;
    @memcpy(dst[0..bytes.len], bytes);
    _ = win32.GlobalUnlock(h);
    return win32.SetClipboardData(format, h) != null;
}

pub fn writeText(gpa: std.mem.Allocator, owner: ?win32.HWND, text: []const u8) void {
    const text_w = std.unicode.utf8ToUtf16LeAllocZ(gpa, text) catch return;
    defer gpa.free(text_w);
    if (win32.OpenClipboard(owner) == 0) return;
    defer _ = win32.CloseClipboard();
    _ = win32.EmptyClipboard();
    _ = setClipboard(win32.CF_UNICODETEXT, std.mem.sliceAsBytes(text_w[0 .. text_w.len + 1]));
}

/// Write both HTML (CF_HTML) and plain (CF_UNICODETEXT) flavors at once
/// (clipboard:writeRich — the preview "copy document" button).
pub fn writeRich(gpa: std.mem.Allocator, owner: ?win32.HWND, html: []const u8, text: []const u8) void {
    const cfhtml = buildCfHtml(gpa, html) catch null;
    defer if (cfhtml) |c| gpa.free(c);
    const text_w = std.unicode.utf8ToUtf16LeAllocZ(gpa, text) catch return;
    defer gpa.free(text_w);

    if (win32.OpenClipboard(owner) == 0) return;
    defer _ = win32.CloseClipboard();
    _ = win32.EmptyClipboard();
    if (cfhtml) |c| {
        const fmt = win32.RegisterClipboardFormatW(std.unicode.utf8ToUtf16LeStringLiteral("HTML Format"));
        if (fmt != 0) _ = setClipboard(fmt, c);
    }
    _ = setClipboard(win32.CF_UNICODETEXT, std.mem.sliceAsBytes(text_w[0 .. text_w.len + 1]));
}

/// Build the CF_HTML payload (UTF-8 with the byte-offset header Windows wants).
fn buildCfHtml(gpa: std.mem.Allocator, html: []const u8) ![]u8 {
    const prefix = "<html><body>\r\n<!--StartFragment-->";
    const suffix = "<!--EndFragment-->\r\n</body></html>";
    const fmt = "Version:0.9\r\nStartHTML:{d:0>10}\r\nEndHTML:{d:0>10}\r\nStartFragment:{d:0>10}\r\nEndFragment:{d:0>10}\r\n";

    // Header length is fixed (10-digit zero-padded offsets), so measure it once.
    const measured = try std.fmt.allocPrint(gpa, fmt, .{ 0, 0, 0, 0 });
    const hlen = measured.len;
    gpa.free(measured);

    const start_html = hlen;
    const start_fragment = hlen + prefix.len;
    const end_fragment = start_fragment + html.len;
    const end_html = hlen + prefix.len + html.len + suffix.len;

    return std.fmt.allocPrintSentinel(gpa, fmt ++ "{s}{s}{s}", .{
        start_html, end_html, start_fragment, end_fragment, prefix, html, suffix,
    }, 0);
}

pub fn readText(gpa: std.mem.Allocator, owner: ?win32.HWND) ?[]u8 {
    if (win32.OpenClipboard(owner) == 0) return null;
    defer _ = win32.CloseClipboard();
    const h = win32.GetClipboardData(win32.CF_UNICODETEXT) orelse return null;
    const ptr = win32.GlobalLock(h) orelse return null;
    defer _ = win32.GlobalUnlock(h);
    const wptr: [*:0]const u16 = @ptrCast(@alignCast(ptr));
    return std.unicode.utf16LeToUtf8Alloc(gpa, std.mem.span(wptr)) catch null;
}
