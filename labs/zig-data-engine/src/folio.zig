//! The `.folio` block model, arena-allocated.
//!
//! This is the encoding the data-engine plan calls "one encoding, three
//! consumers": the file body, the write-ahead log's `PutBlock` payload, and
//! the Zig-JS boundary all speak it. The public spec is
//! `docs/folio-schema-v1.md`; this is its Zig form, and the lab reads that
//! spec rather than importing anything from the app.
//!
//! **Numbers are carried as their source token, never as parsed floats.**
//! The canonical writer must reproduce a file byte-for-byte, and the file's
//! numbers were formatted by JavaScript's `JSON.stringify`. Re-deriving those
//! bytes from an `f64` would mean reimplementing ECMAScript number formatting
//! in Zig and hoping the two agree forever — a silent-drift machine of
//! exactly the kind the "widen together" rule exists to prevent. Keeping the
//! token makes round-trip byte-identity structural instead of a coincidence,
//! and costs nothing: the engine reads a number when it wants one.

const std = @import("std");

/// A JSON number exactly as it appeared in the source, or as the writer of a
/// synthetic block chose to render it. Re-emitted verbatim.
pub const Number = []const u8;

/// Read the token as an integer. Used where the schema promises one
/// (`schemaVersion`, `heading.level`, `ordered_list.start`).
pub fn numberAsInt(n: Number) ?i64 {
    return std.fmt.parseInt(i64, n, 10) catch null;
}

pub const Align = enum { left, right, center };

pub const Link = struct {
    href: []const u8,
    title: ?[]const u8,
};

/// Only set marks are ever emitted. The writer walks these in the spec's
/// canonical order, which is the order declared here.
pub const Marks = struct {
    em: bool = false,
    strong: bool = false,
    code: bool = false,
    strikethrough: bool = false,
    underline: bool = false,
    link: ?Link = null,
};

/// Wire `kind` values are `text`, `image`, `break`, `tag`, `footnote_ref`.
/// `break` is a Zig keyword, so the tag is `line_break` and the mapping is
/// explicit in both the parser and the writer.
pub const Inline = union(enum) {
    text: struct { text: []const u8, marks: Marks },
    image: struct {
        url: []const u8,
        alt: []const u8,
        title: ?[]const u8,
        marks: Marks,
    },
    line_break: struct { marks: Marks },
    tag: struct { name: []const u8, marks: Marks },
    footnote_ref: struct { label: []const u8, marks: Marks },

    pub fn marks(self: Inline) Marks {
        return switch (self) {
            inline else => |v| v.marks,
        };
    }
};

/// `checked` is present only for task-list items; absent for a plain one.
pub const ListItem = struct {
    spread: bool,
    checked: ?bool,
    children: []const Block,
};

pub const Block = struct {
    id: []const u8,
    body: Body,

    /// Field names differ from the wire only where Zig reserves the word:
    /// `inline` becomes `inline_content`, `align` becomes `alignment`.
    pub const Body = union(enum) {
        paragraph: struct { inline_content: []const Inline },
        heading: struct { level: Number, inline_content: []const Inline },
        code_block: struct {
            lang: []const u8,
            meta: ?[]const u8,
            text: []const u8,
        },
        horizontal_rule,
        blockquote: struct { children: []const Block },
        bullet_list: struct { spread: bool, items: []const ListItem },
        ordered_list: struct {
            start: Number,
            spread: bool,
            items: []const ListItem,
        },
        footnote_definition: struct {
            label: []const u8,
            children: []const Block,
        },
        table: struct {
            /// Length equals the column count; an entry is null when the
            /// header gave no alignment.
            alignment: []const ?Align,
            /// Per-column relative weights. Null when the table has no custom
            /// widths. Undocumented in the schema doc as of 2026-08-29 though
            /// the app writes it, and the only place floats reach a `.folio`.
            widths: ?[]const Number,
            /// Row 0 is the header. Ragged rows are legal: the native format
            /// has no column clamp.
            rows: []const []const []const Inline,
        },
    };
};

/// A `docMeta` key a newer writer added. Preserved verbatim across a
/// round-trip so an older reader never silently drops it.
pub const MetaExtra = struct {
    key: []const u8,
    value: std.json.Value,
};

pub const Meta = struct {
    /// Null (or absent) means "derive from the first heading".
    title: ?[]const u8,
    created_at: []const u8,
    /// Unknown keys, in first-seen order.
    extra: []const MetaExtra,
};

pub const Document = struct {
    schema_version: Number,
    doc_id: []const u8,
    meta: Meta,
    blocks: []const Block,
};

pub const schema_version = 1;
