//! The tolerant `.folio` reader.
//!
//! Tolerant in the two ways the spec asks for and no others: unknown
//! `docMeta` keys survive a round trip verbatim, and a container or schema
//! version this reader does not understand is refused with a clear error
//! rather than partially parsed. Structural nonsense is `Malformed` — a file
//! is either the shape the spec describes or it is not.
//!
//! Everything lands in the caller's arena, which is the whole lifetime story:
//! the returned tree borrows from both the arena and the source bytes, and
//! dropping the arena drops the document.

const std = @import("std");
const folio = @import("folio.zig");

const Block = folio.Block;
const Document = folio.Document;
const Inline = folio.Inline;
const ListItem = folio.ListItem;
const Marks = folio.Marks;
const Value = std.json.Value;

pub const ParseError = error{
    OutOfMemory,
    Malformed,
    /// A `schemaVersion` this reader does not know.
    UnsupportedVersion,
    /// The v2 zip container, detected by its `PK` magic.
    UnsupportedContainer,
};

/// Parse a whole document. `arena` owns everything returned.
pub fn parseDocument(arena: std.mem.Allocator, bytes: []const u8) ParseError!Document {
    // Version detection is by the first non-whitespace byte, per the spec, so
    // a zip container is refused before the JSON parser sees binary.
    var i: usize = 0;
    while (i < bytes.len and std.ascii.isWhitespace(bytes[i])) i += 1;
    if (i + 1 < bytes.len and bytes[i] == 'P' and bytes[i + 1] == 'K') {
        return error.UnsupportedContainer;
    }

    const root = std.json.parseFromSliceLeaky(Value, arena, bytes, .{
        // Numbers stay as their source token so the writer can reproduce
        // them byte-for-byte. See `folio.Number`.
        .parse_numbers = false,
    }) catch return error.Malformed;

    const obj = asObject(root) orelse return error.Malformed;

    const version = numberOf(obj.get("schemaVersion") orelse return error.Malformed) orelse
        return error.Malformed;
    const parsed_version = folio.numberAsInt(version) orelse return error.Malformed;
    if (parsed_version != folio.schema_version) return error.UnsupportedVersion;

    const doc_id = stringOf(obj.get("docId") orelse return error.Malformed) orelse
        return error.Malformed;

    const meta = try parseMeta(arena, obj.get("docMeta") orelse return error.Malformed);
    const blocks = try parseBlocks(arena, obj.get("blocks") orelse return error.Malformed);

    return .{
        .schema_version = version,
        .doc_id = doc_id,
        .meta = meta,
        .blocks = blocks,
    };
}

/// Parse one standalone block — the log-record and boundary case.
pub fn parseBlock(arena: std.mem.Allocator, bytes: []const u8) ParseError!Block {
    const value = std.json.parseFromSliceLeaky(Value, arena, bytes, .{
        .parse_numbers = false,
    }) catch return error.Malformed;
    return parseOneBlock(arena, value);
}

// ---- helpers --------------------------------------------------------------

fn asObject(v: Value) ?std.json.ObjectMap {
    return switch (v) {
        .object => |o| o,
        else => null,
    };
}

fn stringOf(v: Value) ?[]const u8 {
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

fn optionalStringOf(v: ?Value) ParseError!?[]const u8 {
    const value = v orelse return null;
    return switch (value) {
        .null => null,
        .string => |s| s,
        else => error.Malformed,
    };
}

fn numberOf(v: Value) ?folio.Number {
    return switch (v) {
        .number_string => |s| s,
        else => null,
    };
}

fn boolOf(v: ?Value) ParseError!bool {
    const value = v orelse return error.Malformed;
    return switch (value) {
        .bool => |b| b,
        else => error.Malformed,
    };
}

fn arrayOf(v: ?Value) ParseError![]Value {
    const value = v orelse return error.Malformed;
    return switch (value) {
        .array => |a| a.items,
        else => error.Malformed,
    };
}

// ---- document parts -------------------------------------------------------

fn parseMeta(arena: std.mem.Allocator, v: Value) ParseError!folio.Meta {
    const obj = asObject(v) orelse return error.Malformed;

    const created_at = stringOf(obj.get("createdAt") orelse return error.Malformed) orelse
        return error.Malformed;

    var extra: std.ArrayList(folio.MetaExtra) = .empty;
    var it = obj.iterator();
    while (it.next()) |entry| {
        const key = entry.key_ptr.*;
        if (std.mem.eql(u8, key, "title") or std.mem.eql(u8, key, "createdAt")) continue;
        try extra.append(arena, .{ .key = key, .value = entry.value_ptr.* });
    }

    return .{
        .title = try optionalStringOf(obj.get("title")),
        .created_at = created_at,
        .extra = try extra.toOwnedSlice(arena),
    };
}

fn parseBlocks(arena: std.mem.Allocator, v: Value) ParseError![]const Block {
    const items = try arrayOf(v);
    const out = try arena.alloc(Block, items.len);
    for (items, out) |item, *slot| slot.* = try parseOneBlock(arena, item);
    return out;
}

fn parseOneBlock(arena: std.mem.Allocator, v: Value) ParseError!Block {
    const obj = asObject(v) orelse return error.Malformed;

    const id = stringOf(obj.get("id") orelse return error.Malformed) orelse
        return error.Malformed;
    const type_name = stringOf(obj.get("type") orelse return error.Malformed) orelse
        return error.Malformed;

    const body: Block.Body = body: {
        if (std.mem.eql(u8, type_name, "paragraph")) {
            break :body .{ .paragraph = .{
                .inline_content = try parseInlines(arena, obj.get("inline")),
            } };
        }
        if (std.mem.eql(u8, type_name, "heading")) {
            const level = numberOf(obj.get("level") orelse return error.Malformed) orelse
                return error.Malformed;
            break :body .{ .heading = .{
                .level = level,
                .inline_content = try parseInlines(arena, obj.get("inline")),
            } };
        }
        if (std.mem.eql(u8, type_name, "code_block")) {
            break :body .{ .code_block = .{
                .lang = stringOf(obj.get("lang") orelse return error.Malformed) orelse
                    return error.Malformed,
                .meta = try optionalStringOf(obj.get("meta")),
                .text = stringOf(obj.get("text") orelse return error.Malformed) orelse
                    return error.Malformed,
            } };
        }
        if (std.mem.eql(u8, type_name, "horizontal_rule")) break :body .horizontal_rule;
        if (std.mem.eql(u8, type_name, "blockquote")) {
            break :body .{ .blockquote = .{
                .children = try parseBlocks(arena, obj.get("children") orelse
                    return error.Malformed),
            } };
        }
        if (std.mem.eql(u8, type_name, "bullet_list")) {
            break :body .{ .bullet_list = .{
                .spread = try boolOf(obj.get("spread")),
                .items = try parseItems(arena, obj.get("items")),
            } };
        }
        if (std.mem.eql(u8, type_name, "ordered_list")) {
            const start = numberOf(obj.get("start") orelse return error.Malformed) orelse
                return error.Malformed;
            break :body .{ .ordered_list = .{
                .start = start,
                .spread = try boolOf(obj.get("spread")),
                .items = try parseItems(arena, obj.get("items")),
            } };
        }
        if (std.mem.eql(u8, type_name, "footnote_definition")) {
            break :body .{ .footnote_definition = .{
                .label = stringOf(obj.get("label") orelse return error.Malformed) orelse
                    return error.Malformed,
                .children = try parseBlocks(arena, obj.get("children") orelse
                    return error.Malformed),
            } };
        }
        if (std.mem.eql(u8, type_name, "table")) break :body .{ .table = try parseTable(arena, obj) };
        return error.Malformed;
    };

    return .{ .id = id, .body = body };
}

fn parseTable(
    arena: std.mem.Allocator,
    obj: std.json.ObjectMap,
) ParseError!@FieldType(Block.Body, "table") {
    const align_items = try arrayOf(obj.get("align"));
    const alignment = try arena.alloc(?folio.Align, align_items.len);
    for (align_items, alignment) |item, *slot| {
        slot.* = switch (item) {
            .null => null,
            .string => |s| std.meta.stringToEnum(folio.Align, s) orelse return error.Malformed,
            else => return error.Malformed,
        };
    }

    var widths: ?[]const folio.Number = null;
    if (obj.get("widths")) |w| {
        const width_items = try arrayOf(w);
        const parsed = try arena.alloc(folio.Number, width_items.len);
        for (width_items, parsed) |item, *slot| {
            slot.* = numberOf(item) orelse return error.Malformed;
        }
        widths = parsed;
    }

    const row_items = try arrayOf(obj.get("rows"));
    const rows = try arena.alloc([]const []const Inline, row_items.len);
    for (row_items, rows) |row_value, *row_slot| {
        const cell_items = try arrayOf(row_value);
        const cells = try arena.alloc([]const Inline, cell_items.len);
        for (cell_items, cells) |cell_value, *cell_slot| {
            cell_slot.* = try parseInlines(arena, cell_value);
        }
        row_slot.* = cells;
    }

    return .{ .alignment = alignment, .widths = widths, .rows = rows };
}

fn parseItems(arena: std.mem.Allocator, v: ?Value) ParseError![]const ListItem {
    const items = try arrayOf(v);
    const out = try arena.alloc(ListItem, items.len);
    for (items, out) |item, *slot| {
        const obj = asObject(item) orelse return error.Malformed;
        const checked: ?bool = if (obj.get("checked")) |c| switch (c) {
            .bool => |b| b,
            else => return error.Malformed,
        } else null;
        slot.* = .{
            .spread = try boolOf(obj.get("spread")),
            .checked = checked,
            .children = try parseBlocks(arena, obj.get("children") orelse return error.Malformed),
        };
    }
    return out;
}

fn parseInlines(arena: std.mem.Allocator, v: ?Value) ParseError![]const Inline {
    const items = try arrayOf(v);
    const out = try arena.alloc(Inline, items.len);
    for (items, out) |item, *slot| slot.* = try parseInline(item);
    return out;
}

fn parseInline(v: Value) ParseError!Inline {
    const obj = asObject(v) orelse return error.Malformed;
    const kind = stringOf(obj.get("kind") orelse return error.Malformed) orelse
        return error.Malformed;
    const marks = try parseMarks(obj.get("marks"));

    if (std.mem.eql(u8, kind, "text")) {
        return .{ .text = .{
            .text = stringOf(obj.get("text") orelse return error.Malformed) orelse
                return error.Malformed,
            .marks = marks,
        } };
    }
    if (std.mem.eql(u8, kind, "image")) {
        return .{ .image = .{
            .url = stringOf(obj.get("url") orelse return error.Malformed) orelse
                return error.Malformed,
            .alt = stringOf(obj.get("alt") orelse return error.Malformed) orelse
                return error.Malformed,
            .title = try optionalStringOf(obj.get("title")),
            .marks = marks,
        } };
    }
    if (std.mem.eql(u8, kind, "break")) return .{ .line_break = .{ .marks = marks } };
    if (std.mem.eql(u8, kind, "tag")) {
        return .{ .tag = .{
            .name = stringOf(obj.get("name") orelse return error.Malformed) orelse
                return error.Malformed,
            .marks = marks,
        } };
    }
    if (std.mem.eql(u8, kind, "footnote_ref")) {
        return .{ .footnote_ref = .{
            .label = stringOf(obj.get("label") orelse return error.Malformed) orelse
                return error.Malformed,
            .marks = marks,
        } };
    }
    return error.Malformed;
}

fn parseMarks(v: ?Value) ParseError!Marks {
    const value = v orelse return .{};
    const obj = asObject(value) orelse return error.Malformed;

    var marks: Marks = .{};
    marks.em = try markFlag(obj, "em");
    marks.strong = try markFlag(obj, "strong");
    marks.code = try markFlag(obj, "code");
    marks.strikethrough = try markFlag(obj, "strikethrough");
    marks.underline = try markFlag(obj, "underline");

    if (obj.get("link")) |link_value| {
        const link = asObject(link_value) orelse return error.Malformed;
        marks.link = .{
            .href = stringOf(link.get("href") orelse return error.Malformed) orelse
                return error.Malformed,
            .title = try optionalStringOf(link.get("title")),
        };
    }
    return marks;
}

fn markFlag(obj: std.json.ObjectMap, name: []const u8) ParseError!bool {
    const value = obj.get(name) orelse return false;
    return switch (value) {
        .bool => |b| b,
        else => error.Malformed,
    };
}
