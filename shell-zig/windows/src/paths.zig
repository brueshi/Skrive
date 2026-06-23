//! Windows app-data paths. The host stores the core's persistence and the
//! WebView2 user-data folder under %APPDATA%\Skrive (sandbox-accessible and
//! writable, unlike a folder next to the exe once installed under Program
//! Files).

const std = @import("std");
const win32 = @import("win32.zig");

/// %APPDATA%\Skrive, created if missing. Caller owns the returned WTF-8 path.
pub fn appDataDir(gpa: std.mem.Allocator) ![]u8 {
    var buf: [32768]u16 = undefined;
    const name = std.unicode.utf8ToUtf16LeStringLiteral("APPDATA");
    const n = win32.GetEnvironmentVariableW(name, &buf, buf.len);
    if (n == 0 or n >= buf.len) return error.NoAppData;
    const appdata = try std.unicode.utf16LeToUtf8Alloc(gpa, buf[0..n]);
    defer gpa.free(appdata);

    const dir = try std.fs.path.join(gpa, &.{ appdata, "Skrive" });
    errdefer gpa.free(dir);
    const dir_w = try std.unicode.utf8ToUtf16LeAllocZ(gpa, dir);
    defer gpa.free(dir_w);
    _ = win32.CreateDirectoryW(dir_w.ptr, null); // ignore "already exists"
    return dir;
}
