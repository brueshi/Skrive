//! The canonical `.folio` writer.
//!
//! Reproduces `JSON.stringify(doc, null, 2) + "\n"` exactly, with keys in the
//! spec's fixed order. Byte-identity is the point: unchanged content must
//! produce an unchanged file, so a no-op save rewrites nothing and diffs stay
//! clean, and — the reason this lab cares — a block encoded here must equal a
//! block encoded by the app, or "one encoding, three consumers" is not true.
//!
//! Shape rules, matching `JSON.stringify` with a two-space indent: an empty
//! object is `{}` and an empty array is `[]` with nothing between the
//! brackets; a non-empty one puts every member on its own line indented two
//! spaces deeper, with the closing bracket back at the parent's indent.
//! Strings escape only `"` `\` and the C0 controls, so UTF-8 passes through
//! as itself.

const std = @import("std");
const folio = @import("folio.zig");

const Block = folio.Block;
const Document = folio.Document;
const Inline = folio.Inline;
const ListItem = folio.ListItem;
const Marks = folio.Marks;

const hex = "0123456789abcdef";

const Out = struct {
    gpa: std.mem.Allocator,
    buf: *std.ArrayList(u8),
    depth: usize = 0,

    fn raw(self: *Out, s: []const u8) error{OutOfMemory}!void {
        try self.buf.appendSlice(self.gpa, s);
    }

    fn byte(self: *Out, c: u8) error{OutOfMemory}!void {
        try self.buf.append(self.gpa, c);
    }

    /// Newline plus the current indent. Used before every member of a
    /// non-empty object or array.
    fn line(self: *Out) error{OutOfMemory}!void {
        try self.byte('\n');
        var i: usize = 0;
        while (i < self.depth * 2) : (i += 1) try self.byte(' ');
    }

    fn string(self: *Out, s: []const u8) error{OutOfMemory}!void {
        try self.byte('"');
        for (s) |c| switch (c) {
            '"' => try self.raw("\\\""),
            '\\' => try self.raw("\\\\"),
            0x08 => try self.raw("\\b"),
            0x09 => try self.raw("\\t"),
            0x0a => try self.raw("\\n"),
            0x0c => try self.raw("\\f"),
            0x0d => try self.raw("\\r"),
            else => {
                if (c < 0x20) {
                    // Every remaining control character. JSON.stringify emits
                    // lowercase hex here.
                    try self.raw("\\u00");
                    try self.byte(hex[(c >> 4) & 0xf]);
                    try self.byte(hex[c & 0xf]);
                } else {
                    try self.byte(c);
                }
            },
        };
        try self.byte('"');
    }

    fn key(self: *Out, name: []const u8) error{OutOfMemory}!void {
        try self.string(name);
        try self.raw(": ");
    }

    fn optionalString(self: *Out, s: ?[]const u8) error{OutOfMemory}!void {
        if (s) |v| try self.string(v) else try self.raw("null");
    }
};

/// Serialize a document to its canonical bytes. Caller owns the result.
pub fn writeDocument(gpa: std.mem.Allocator, doc: Document) error{OutOfMemory}![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(gpa);
    var out = Out{ .gpa = gpa, .buf = &buf };

    try out.raw("{");
    out.depth += 1;

    try out.line();
    try out.key("schemaVersion");
    try out.raw(doc.schema_version);

    try out.raw(",");
    try out.line();
    try out.key("docId");
    try out.string(doc.doc_id);

    try out.raw(",");
    try out.line();
    try out.key("docMeta");
    try writeMeta(&out, doc.meta);

    try out.raw(",");
    try out.line();
    try out.key("blocks");
    try writeBlocks(&out, doc.blocks);

    out.depth -= 1;
    try out.line();
    try out.raw("}\n");

    return buf.toOwnedSlice(gpa);
}

/// Serialize one block on its own — the property the schema requires so a
/// block can be a log record payload or cross the boundary without its
/// document. Written at indent zero.
pub fn writeBlock(gpa: std.mem.Allocator, block: Block) error{OutOfMemory}![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(gpa);
    var out = Out{ .gpa = gpa, .buf = &buf };
    try writeOneBlock(&out, block);
    return buf.toOwnedSlice(gpa);
}

fn writeMeta(out: *Out, meta: folio.Meta) error{OutOfMemory}!void {
    try out.raw("{");
    out.depth += 1;

    try out.line();
    try out.key("title");
    try out.optionalString(meta.title);

    try out.raw(",");
    try out.line();
    try out.key("createdAt");
    try out.string(meta.created_at);

    for (meta.extra) |e| {
        try out.raw(",");
        try out.line();
        try out.key(e.key);
        try writeValue(out, e.value);
    }

    out.depth -= 1;
    try out.line();
    try out.raw("}");
}

fn writeBlocks(out: *Out, blocks: []const Block) error{OutOfMemory}!void {
    if (blocks.len == 0) {
        try out.raw("[]");
        return;
    }
    try out.raw("[");
    out.depth += 1;
    for (blocks, 0..) |b, i| {
        if (i != 0) try out.raw(",");
        try out.line();
        try writeOneBlock(out, b);
    }
    out.depth -= 1;
    try out.line();
    try out.raw("]");
}

fn writeOneBlock(out: *Out, block: Block) error{OutOfMemory}!void {
    try out.raw("{");
    out.depth += 1;

    try out.line();
    try out.key("id");
    try out.string(block.id);

    try out.raw(",");
    try out.line();
    try out.key("type");
    try out.string(@tagName(block.body));

    switch (block.body) {
        .paragraph => |p| {
            try out.raw(",");
            try out.line();
            try out.key("inline");
            try writeInlines(out, p.inline_content);
        },
        .heading => |h| {
            try out.raw(",");
            try out.line();
            try out.key("level");
            try out.raw(h.level);
            try out.raw(",");
            try out.line();
            try out.key("inline");
            try writeInlines(out, h.inline_content);
        },
        .code_block => |c| {
            try out.raw(",");
            try out.line();
            try out.key("lang");
            try out.string(c.lang);
            try out.raw(",");
            try out.line();
            try out.key("meta");
            try out.optionalString(c.meta);
            try out.raw(",");
            try out.line();
            try out.key("text");
            try out.string(c.text);
        },
        .horizontal_rule => {},
        .blockquote => |q| {
            try out.raw(",");
            try out.line();
            try out.key("children");
            try writeBlocks(out, q.children);
        },
        .bullet_list => |l| {
            try out.raw(",");
            try out.line();
            try out.key("spread");
            try out.raw(if (l.spread) "true" else "false");
            try out.raw(",");
            try out.line();
            try out.key("items");
            try writeItems(out, l.items);
        },
        .ordered_list => |l| {
            try out.raw(",");
            try out.line();
            try out.key("start");
            try out.raw(l.start);
            try out.raw(",");
            try out.line();
            try out.key("spread");
            try out.raw(if (l.spread) "true" else "false");
            try out.raw(",");
            try out.line();
            try out.key("items");
            try writeItems(out, l.items);
        },
        .footnote_definition => |f| {
            try out.raw(",");
            try out.line();
            try out.key("label");
            try out.string(f.label);
            try out.raw(",");
            try out.line();
            try out.key("children");
            try writeBlocks(out, f.children);
        },
        .table => |t| {
            try out.raw(",");
            try out.line();
            try out.key("align");
            try writeAlign(out, t.alignment);
            if (t.widths) |w| {
                try out.raw(",");
                try out.line();
                try out.key("widths");
                try writeNumberArray(out, w);
            }
            try out.raw(",");
            try out.line();
            try out.key("rows");
            try writeRows(out, t.rows);
        },
    }

    out.depth -= 1;
    try out.line();
    try out.raw("}");
}

fn writeItems(out: *Out, items: []const ListItem) error{OutOfMemory}!void {
    if (items.len == 0) {
        try out.raw("[]");
        return;
    }
    try out.raw("[");
    out.depth += 1;
    for (items, 0..) |item, i| {
        if (i != 0) try out.raw(",");
        try out.line();

        try out.raw("{");
        out.depth += 1;

        try out.line();
        try out.key("spread");
        try out.raw(if (item.spread) "true" else "false");

        if (item.checked) |c| {
            try out.raw(",");
            try out.line();
            try out.key("checked");
            try out.raw(if (c) "true" else "false");
        }

        try out.raw(",");
        try out.line();
        try out.key("children");
        try writeBlocks(out, item.children);

        out.depth -= 1;
        try out.line();
        try out.raw("}");
    }
    out.depth -= 1;
    try out.line();
    try out.raw("]");
}

fn writeAlign(out: *Out, alignment: []const ?folio.Align) error{OutOfMemory}!void {
    if (alignment.len == 0) {
        try out.raw("[]");
        return;
    }
    try out.raw("[");
    out.depth += 1;
    for (alignment, 0..) |a, i| {
        if (i != 0) try out.raw(",");
        try out.line();
        if (a) |v| try out.string(@tagName(v)) else try out.raw("null");
    }
    out.depth -= 1;
    try out.line();
    try out.raw("]");
}

fn writeNumberArray(out: *Out, nums: []const folio.Number) error{OutOfMemory}!void {
    if (nums.len == 0) {
        try out.raw("[]");
        return;
    }
    try out.raw("[");
    out.depth += 1;
    for (nums, 0..) |n, i| {
        if (i != 0) try out.raw(",");
        try out.line();
        try out.raw(n);
    }
    out.depth -= 1;
    try out.line();
    try out.raw("]");
}

fn writeRows(out: *Out, rows: []const []const []const Inline) error{OutOfMemory}!void {
    if (rows.len == 0) {
        try out.raw("[]");
        return;
    }
    try out.raw("[");
    out.depth += 1;
    for (rows, 0..) |row, i| {
        if (i != 0) try out.raw(",");
        try out.line();
        if (row.len == 0) {
            try out.raw("[]");
            continue;
        }
        try out.raw("[");
        out.depth += 1;
        for (row, 0..) |cell, j| {
            if (j != 0) try out.raw(",");
            try out.line();
            try writeInlines(out, cell);
        }
        out.depth -= 1;
        try out.line();
        try out.raw("]");
    }
    out.depth -= 1;
    try out.line();
    try out.raw("]");
}

fn writeInlines(out: *Out, inlines: []const Inline) error{OutOfMemory}!void {
    if (inlines.len == 0) {
        try out.raw("[]");
        return;
    }
    try out.raw("[");
    out.depth += 1;
    for (inlines, 0..) |n, i| {
        if (i != 0) try out.raw(",");
        try out.line();
        try writeInline(out, n);
    }
    out.depth -= 1;
    try out.line();
    try out.raw("]");
}

fn writeInline(out: *Out, node: Inline) error{OutOfMemory}!void {
    try out.raw("{");
    out.depth += 1;

    try out.line();
    try out.key("kind");
    try out.string(switch (node) {
        .text => "text",
        .image => "image",
        .line_break => "break",
        .tag => "tag",
        .footnote_ref => "footnote_ref",
    });

    switch (node) {
        .text => |t| {
            try out.raw(",");
            try out.line();
            try out.key("text");
            try out.string(t.text);
        },
        .image => |img| {
            try out.raw(",");
            try out.line();
            try out.key("url");
            try out.string(img.url);
            try out.raw(",");
            try out.line();
            try out.key("alt");
            try out.string(img.alt);
            try out.raw(",");
            try out.line();
            try out.key("title");
            try out.optionalString(img.title);
        },
        .line_break => {},
        .tag => |t| {
            try out.raw(",");
            try out.line();
            try out.key("name");
            try out.string(t.name);
        },
        .footnote_ref => |f| {
            try out.raw(",");
            try out.line();
            try out.key("label");
            try out.string(f.label);
        },
    }

    try out.raw(",");
    try out.line();
    try out.key("marks");
    try writeMarks(out, node.marks());

    out.depth -= 1;
    try out.line();
    try out.raw("}");
}

fn writeMarks(out: *Out, marks: Marks) error{OutOfMemory}!void {
    const bools = [_]struct { name: []const u8, set: bool }{
        .{ .name = "em", .set = marks.em },
        .{ .name = "strong", .set = marks.strong },
        .{ .name = "code", .set = marks.code },
        .{ .name = "strikethrough", .set = marks.strikethrough },
        .{ .name = "underline", .set = marks.underline },
    };

    var any = marks.link != null;
    for (bools) |b| {
        if (b.set) any = true;
    }
    if (!any) {
        try out.raw("{}");
        return;
    }

    try out.raw("{");
    out.depth += 1;
    var first = true;
    for (bools) |b| {
        if (!b.set) continue;
        if (!first) try out.raw(",");
        first = false;
        try out.line();
        try out.key(b.name);
        try out.raw("true");
    }
    if (marks.link) |link| {
        if (!first) try out.raw(",");
        try out.line();
        try out.key("link");
        try out.raw("{");
        out.depth += 1;
        try out.line();
        try out.key("href");
        try out.string(link.href);
        try out.raw(",");
        try out.line();
        try out.key("title");
        try out.optionalString(link.title);
        out.depth -= 1;
        try out.line();
        try out.raw("}");
    }
    out.depth -= 1;
    try out.line();
    try out.raw("}");
}

/// Preserved `docMeta` values from a newer writer. Re-printed with the same
/// shape rules so the round trip is byte-stable regardless of how the value
/// was originally laid out.
fn writeValue(out: *Out, value: std.json.Value) error{OutOfMemory}!void {
    switch (value) {
        .null => try out.raw("null"),
        .bool => |b| try out.raw(if (b) "true" else "false"),
        .integer => |i| {
            var tmp: [24]u8 = undefined;
            const s = std.fmt.bufPrint(&tmp, "{d}", .{i}) catch unreachable;
            try out.raw(s);
        },
        .float => |f| {
            var tmp: [32]u8 = undefined;
            const s = std.fmt.bufPrint(&tmp, "{d}", .{f}) catch unreachable;
            try out.raw(s);
        },
        .number_string => |s| try out.raw(s),
        .string => |s| try out.string(s),
        .array => |arr| {
            if (arr.items.len == 0) {
                try out.raw("[]");
                return;
            }
            try out.raw("[");
            out.depth += 1;
            for (arr.items, 0..) |v, i| {
                if (i != 0) try out.raw(",");
                try out.line();
                try writeValue(out, v);
            }
            out.depth -= 1;
            try out.line();
            try out.raw("]");
        },
        .object => |obj| {
            if (obj.count() == 0) {
                try out.raw("{}");
                return;
            }
            try out.raw("{");
            out.depth += 1;
            var it = obj.iterator();
            var i: usize = 0;
            while (it.next()) |entry| : (i += 1) {
                if (i != 0) try out.raw(",");
                try out.line();
                try out.key(entry.key_ptr.*);
                try writeValue(out, entry.value_ptr.*);
            }
            out.depth -= 1;
            try out.line();
            try out.raw("}");
        },
    }
}
