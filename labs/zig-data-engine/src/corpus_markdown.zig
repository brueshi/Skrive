//! Markdown rendering for the corpus generator.
//!
//! Deliberately **not** a general `.md` serializer: it renders exactly the
//! block and inline shapes `corpus.zig` produces, whose text is lowercase
//! ASCII words, so it does no escaping and handles no construct the generator
//! never emits. Its job is to give every generated document a second encoding
//! so the `.md` and `.folio` index paths can be compared on identical
//! content — not to round-trip arbitrary documents.

const std = @import("std");
const folio = @import("folio.zig");

const Block = folio.Block;
const Inline = folio.Inline;

pub fn renderDocument(gpa: std.mem.Allocator, doc: folio.Document) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try renderBlocks(gpa, &out, doc.blocks);
    return out.toOwnedSlice(gpa);
}

fn renderBlocks(gpa: std.mem.Allocator, out: *std.ArrayList(u8), blocks: []const Block) error{OutOfMemory}!void {
    for (blocks, 0..) |b, i| {
        if (i != 0) try out.appendSlice(gpa, "\n");
        try renderBlock(gpa, out, b);
    }
}

fn renderBlock(gpa: std.mem.Allocator, out: *std.ArrayList(u8), b: Block) error{OutOfMemory}!void {
    switch (b.body) {
        .heading => |h| {
            const level = folio.numberAsInt(h.level) orelse 1;
            var i: i64 = 0;
            while (i < level) : (i += 1) try out.append(gpa, '#');
            try out.append(gpa, ' ');
            try renderInlines(gpa, out, h.inline_content);
            try out.append(gpa, '\n');
        },
        .paragraph => |p| {
            try renderInlines(gpa, out, p.inline_content);
            try out.append(gpa, '\n');
        },
        .code_block => |c| {
            try out.appendSlice(gpa, "```");
            try out.appendSlice(gpa, c.lang);
            try out.append(gpa, '\n');
            try out.appendSlice(gpa, c.text);
            if (c.text.len != 0 and c.text[c.text.len - 1] != '\n') try out.append(gpa, '\n');
            try out.appendSlice(gpa, "```\n");
        },
        .horizontal_rule => try out.appendSlice(gpa, "---\n"),
        .blockquote => |q| {
            var inner: std.ArrayList(u8) = .empty;
            defer inner.deinit(gpa);
            try renderBlocks(gpa, &inner, q.children);
            try prefixLines(gpa, out, inner.items, "> ");
        },
        .bullet_list => |l| {
            for (l.items) |item| {
                const marker: []const u8 = if (item.checked) |c|
                    (if (c) "- [x] " else "- [ ] ")
                else
                    "- ";
                try renderItem(gpa, out, item.children, marker);
            }
        },
        .ordered_list => |l| {
            var n: i64 = folio.numberAsInt(l.start) orelse 1;
            for (l.items) |item| {
                var marker_buf: [24]u8 = undefined;
                const marker = std.fmt.bufPrint(&marker_buf, "{d}. ", .{n}) catch unreachable;
                try renderItem(gpa, out, item.children, marker);
                n += 1;
            }
        },
        .footnote_definition => |f| {
            var inner: std.ArrayList(u8) = .empty;
            defer inner.deinit(gpa);
            try renderBlocks(gpa, &inner, f.children);
            try out.appendSlice(gpa, "[^");
            try out.appendSlice(gpa, f.label);
            try out.appendSlice(gpa, "]: ");
            try out.appendSlice(gpa, std.mem.trimEnd(u8, inner.items, "\n"));
            try out.append(gpa, '\n');
        },
        .table => |t| try renderTable(gpa, out, t),
    }
}

fn renderItem(
    gpa: std.mem.Allocator,
    out: *std.ArrayList(u8),
    children: []const Block,
    marker: []const u8,
) error{OutOfMemory}!void {
    var inner: std.ArrayList(u8) = .empty;
    defer inner.deinit(gpa);
    try renderBlocks(gpa, &inner, children);

    const trimmed = std.mem.trimEnd(u8, inner.items, "\n");
    var lines = std.mem.splitScalar(u8, trimmed, '\n');
    var first = true;
    while (lines.next()) |line| {
        try out.appendSlice(gpa, if (first) marker else "  ");
        try out.appendSlice(gpa, line);
        try out.append(gpa, '\n');
        first = false;
    }
}

fn prefixLines(
    gpa: std.mem.Allocator,
    out: *std.ArrayList(u8),
    text: []const u8,
    prefix: []const u8,
) error{OutOfMemory}!void {
    const trimmed = std.mem.trimEnd(u8, text, "\n");
    var lines = std.mem.splitScalar(u8, trimmed, '\n');
    while (lines.next()) |line| {
        try out.appendSlice(gpa, prefix);
        try out.appendSlice(gpa, line);
        try out.append(gpa, '\n');
    }
}

fn renderTable(
    gpa: std.mem.Allocator,
    out: *std.ArrayList(u8),
    t: @FieldType(Block.Body, "table"),
) error{OutOfMemory}!void {
    if (t.rows.len == 0) return;

    for (t.rows, 0..) |row, row_index| {
        try out.appendSlice(gpa, "|");
        for (row) |cell| {
            try out.append(gpa, ' ');
            try renderInlines(gpa, out, cell);
            try out.appendSlice(gpa, " |");
        }
        try out.append(gpa, '\n');

        if (row_index == 0) {
            try out.appendSlice(gpa, "|");
            for (t.alignment) |a| {
                try out.appendSlice(gpa, switch (a orelse .left) {
                    .left => " --- |",
                    .right => " ---: |",
                    .center => " :---: |",
                });
            }
            try out.append(gpa, '\n');
        }
    }
}

fn renderInlines(gpa: std.mem.Allocator, out: *std.ArrayList(u8), inlines: []const Inline) error{OutOfMemory}!void {
    for (inlines) |n| try renderInline(gpa, out, n);
}

fn renderInline(gpa: std.mem.Allocator, out: *std.ArrayList(u8), node: Inline) error{OutOfMemory}!void {
    const marks = node.marks();

    // Link is outermost so its label carries the emphasis, matching how the
    // app writes it.
    if (marks.link) |_| try out.append(gpa, '[');
    if (marks.strikethrough) try out.appendSlice(gpa, "~~");
    if (marks.strong) try out.appendSlice(gpa, "**");
    if (marks.em) try out.append(gpa, '*');
    if (marks.code) try out.append(gpa, '`');

    switch (node) {
        .text => |t| try out.appendSlice(gpa, t.text),
        .tag => |t| {
            try out.append(gpa, '#');
            try out.appendSlice(gpa, t.name);
        },
        .line_break => try out.appendSlice(gpa, "  \n"),
        .image => |img| {
            try out.appendSlice(gpa, "![");
            try out.appendSlice(gpa, img.alt);
            try out.appendSlice(gpa, "](");
            try out.appendSlice(gpa, img.url);
            try out.append(gpa, ')');
        },
        .footnote_ref => |f| {
            try out.appendSlice(gpa, "[^");
            try out.appendSlice(gpa, f.label);
            try out.append(gpa, ']');
        },
    }

    if (marks.code) try out.append(gpa, '`');
    if (marks.em) try out.append(gpa, '*');
    if (marks.strong) try out.appendSlice(gpa, "**");
    if (marks.strikethrough) try out.appendSlice(gpa, "~~");
    if (marks.link) |link| {
        try out.appendSlice(gpa, "](");
        try out.appendSlice(gpa, link.href);
        try out.append(gpa, ')');
    }
}
