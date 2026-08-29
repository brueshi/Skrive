//! A block-level scanner for `.md`.
//!
//! Deliberately not a Markdown parser. The dual-mode rule keeps the
//! serializer off the `.md` save path but says nothing about reading, and
//! what the engine needs from a `.md` file is exactly this: where the blocks
//! begin and end, what kind each one is, and the text and links inside them.
//! Nothing here builds a document model, and nothing here round-trips —
//! `.md` is a read-only indexing tier.
//!
//! The identity difference from `.folio` is the point of measuring both.
//! A `.folio` block carries a stable id and re-indexes on its own; a `.md`
//! block has no id, so it is keyed by `(path, ordinal)` and a save
//! re-indexes the whole file.

const std = @import("std");
const tokenize = @import("tokenize.zig");

const BlockKind = tokenize.BlockKind;

pub const Scanned = struct {
    kind: BlockKind,
    /// Borrowed from the source text.
    text: []const u8,
};

/// Split a document into blocks. Blank lines separate them, except inside a
/// fenced code block, where they are content.
pub fn scan(gpa: std.mem.Allocator, source: []const u8) ![]Scanned {
    var out: std.ArrayList(Scanned) = .empty;
    errdefer out.deinit(gpa);

    var lines = std.mem.splitScalar(u8, source, '\n');
    var block_start: ?usize = null;
    var block_end: usize = 0;
    var in_fence = false;
    var offset: usize = 0;

    while (lines.next()) |line| {
        const line_start = offset;
        offset += line.len + 1;

        const trimmed = std.mem.trim(u8, line, " \t\r");
        const fence = std.mem.startsWith(u8, trimmed, "```");

        if (fence) {
            if (in_fence) {
                in_fence = false;
                block_end = line_start + line.len;
                try push(gpa, &out, source, block_start, block_end);
                block_start = null;
                continue;
            }
            // A fence opening closes whatever preceded it.
            try push(gpa, &out, source, block_start, block_end);
            block_start = line_start;
            block_end = line_start + line.len;
            in_fence = true;
            continue;
        }

        if (in_fence) {
            block_end = line_start + line.len;
            continue;
        }

        if (trimmed.len == 0) {
            try push(gpa, &out, source, block_start, block_end);
            block_start = null;
            continue;
        }

        if (block_start == null) block_start = line_start;
        block_end = line_start + line.len;
    }
    try push(gpa, &out, source, block_start, block_end);

    return out.toOwnedSlice(gpa);
}

fn push(
    gpa: std.mem.Allocator,
    out: *std.ArrayList(Scanned),
    source: []const u8,
    start: ?usize,
    end: usize,
) !void {
    const from = start orelse return;
    if (end <= from) return;
    const text = source[from..end];
    if (std.mem.trim(u8, text, " \t\r\n").len == 0) return;
    try out.append(gpa, .{ .kind = kindOf(text), .text = text });
}

fn kindOf(text: []const u8) BlockKind {
    const trimmed = std.mem.trimStart(u8, text, " \t");
    if (std.mem.startsWith(u8, trimmed, "```")) return .code;
    if (std.mem.startsWith(u8, trimmed, "#")) {
        // ATX heading only when the hashes are followed by a space.
        var i: usize = 0;
        while (i < trimmed.len and trimmed[i] == '#') i += 1;
        if (i <= 6 and i < trimmed.len and trimmed[i] == ' ') return .heading;
        return .paragraph;
    }
    if (std.mem.startsWith(u8, trimmed, ">")) return .quote;
    if (std.mem.startsWith(u8, trimmed, "|")) return .table_cell;
    if (std.mem.startsWith(u8, trimmed, "[^")) return .footnote;
    if (std.mem.startsWith(u8, trimmed, "- ") or
        std.mem.startsWith(u8, trimmed, "* ") or
        std.mem.startsWith(u8, trimmed, "+ ")) return .list_item;
    // An ordered item: digits then `.` or `)` then a space.
    var i: usize = 0;
    while (i < trimmed.len and std.ascii.isDigit(trimmed[i])) i += 1;
    if (i > 0 and i + 1 < trimmed.len and
        (trimmed[i] == '.' or trimmed[i] == ')') and trimmed[i + 1] == ' ') return .list_item;

    return .paragraph;
}

pub const Harvest = struct {
    tokens: []const tokenize.Token,
    links: []const []const u8,
};

/// Terms and link targets from one scanned block.
///
/// Inline syntax is stripped rather than interpreted: `**` and `` ` `` and
/// `~~` are separators like any other punctuation once the tokenizer runs, so
/// the only cases needing real handling are the ones that carry a payload the
/// tokenizer must not see as prose — a link's target, which belongs to the
/// backlink index and never to the term index.
pub fn harvest(gpa: std.mem.Allocator, block: Scanned) !Harvest {
    var tokens: std.ArrayList(tokenize.Token) = .empty;
    var links: std.ArrayList([]const u8) = .empty;

    var prose: std.ArrayList(u8) = .empty;
    defer prose.deinit(gpa);

    var i: usize = 0;
    while (i < block.text.len) {
        // `[label](target)` — keep the label as prose, take the target as a link.
        if (block.text[i] == '[') {
            if (std.mem.indexOfScalarPos(u8, block.text, i, ']')) |close| {
                if (close + 1 < block.text.len and block.text[close + 1] == '(') {
                    if (std.mem.indexOfScalarPos(u8, block.text, close + 2, ')')) |end| {
                        try prose.appendSlice(gpa, block.text[i + 1 .. close]);
                        try prose.append(gpa, ' ');
                        try links.append(gpa, block.text[close + 2 .. end]);
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        try prose.append(gpa, block.text[i]);
        i += 1;
    }

    var start: ?usize = null;
    for (prose.items, 0..) |c, at| {
        if (std.ascii.isAlphanumeric(c)) {
            if (start == null) start = at;
        } else if (start) |from| {
            try emit(gpa, &tokens, prose.items[from..at], block.kind);
            start = null;
        }
    }
    if (start) |from| try emit(gpa, &tokens, prose.items[from..], block.kind);

    return .{
        .tokens = try tokens.toOwnedSlice(gpa),
        .links = try links.toOwnedSlice(gpa),
    };
}

fn emit(
    gpa: std.mem.Allocator,
    out: *std.ArrayList(tokenize.Token),
    raw: []const u8,
    kind: BlockKind,
) !void {
    const lowered = try gpa.alloc(u8, raw.len);
    for (raw, lowered) |c, *o| o.* = std.ascii.toLower(c);
    try out.append(gpa, .{ .text = lowered, .kind = kind });
}
