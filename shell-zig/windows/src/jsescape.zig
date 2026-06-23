//! The renderer delivery rule (master plan, Part I, security-normative).
//!
//! Core responses and events reach the renderer ONLY as
//! `window.__skriveDispatch(<JS string literal>)`: the envelope is JSON-encoded
//! by the core, then escaped here as a JavaScript string literal and handed to
//! WebView2's `ExecuteScript`. Payload fields (file contents) are never spliced
//! into a script unescaped — this is what stops a Markdown file from becoming
//! script. A byte-for-byte port of the macOS host's SkriveShellKit/JSEscape.swift
//! so the rule is identical across both shells.

const std = @import("std");

/// Wrap an arbitrary UTF-8 string as a double-quoted JS string literal whose
/// parsed value is byte-identical to the input. Escapes the structural
/// characters, the C0 controls, U+2028/U+2029 (legal in JSON, illegal
/// unescaped in JS source), and `<` (neutralizes `</script>` and `<!--`).
/// Caller owns the returned slice.
pub fn stringLiteral(gpa: std.mem.Allocator, s: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.append(gpa, '"');

    var it = (try std.unicode.Utf8View.init(s)).iterator();
    while (it.nextCodepoint()) |cp| {
        switch (cp) {
            '\\' => try out.appendSlice(gpa, "\\\\"),
            '"' => try out.appendSlice(gpa, "\\\""),
            '\n' => try out.appendSlice(gpa, "\\n"),
            '\r' => try out.appendSlice(gpa, "\\r"),
            '\t' => try out.appendSlice(gpa, "\\t"),
            '<' => try out.appendSlice(gpa, "\\u003C"),
            0x2028 => try out.appendSlice(gpa, "\\u2028"),
            0x2029 => try out.appendSlice(gpa, "\\u2029"),
            else => {
                if (cp < 0x20) {
                    var tmp: [6]u8 = undefined;
                    const hex = try std.fmt.bufPrint(&tmp, "\\u{X:0>4}", .{cp});
                    try out.appendSlice(gpa, hex);
                } else {
                    var buf: [4]u8 = undefined;
                    const n = try std.unicode.utf8Encode(cp, &buf);
                    try out.appendSlice(gpa, buf[0..n]);
                }
            },
        }
    }

    try out.append(gpa, '"');
    return out.toOwnedSlice(gpa);
}

// ---- tests (pure logic — run on the native host, no Windows needed) --------

test "plain ASCII passes through, wrapped in quotes" {
    const a = std.testing.allocator;
    const out = try stringLiteral(a, "hello");
    defer a.free(out);
    try std.testing.expectEqualStrings("\"hello\"", out);
}

test "structural chars escape and </script> is neutralized" {
    const a = std.testing.allocator;
    const out = try stringLiteral(a, "a\"b\\c\n</script>");
    defer a.free(out);
    try std.testing.expectEqualStrings("\"a\\\"b\\\\c\\n\\u003C/script>\"", out);
}

test "tab and carriage return escape" {
    const a = std.testing.allocator;
    const out = try stringLiteral(a, "x\ty\rz");
    defer a.free(out);
    try std.testing.expectEqualStrings("\"x\\ty\\rz\"", out);
}

test "U+2028 and U+2029 escape (the JSON-legal/JS-illegal line terminators)" {
    const a = std.testing.allocator;
    const out = try stringLiteral(a, "x\u{2028}y\u{2029}z");
    defer a.free(out);
    try std.testing.expectEqualStrings("\"x\\u2028y\\u2029z\"", out);
}

test "C0 control chars use uppercase \\u00XX" {
    const a = std.testing.allocator;
    const out = try stringLiteral(a, "\x01\x1f");
    defer a.free(out);
    try std.testing.expectEqualStrings("\"\\u0001\\u001F\"", out);
}

test "non-ASCII printable UTF-8 passes through unchanged" {
    const a = std.testing.allocator;
    const out = try stringLiteral(a, "café — 日本語");
    defer a.free(out);
    try std.testing.expectEqualStrings("\"café — 日本語\"", out);
}
