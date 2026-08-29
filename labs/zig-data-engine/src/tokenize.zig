//! Turning blocks into terms.
//!
//! What counts as a term decides what the index can answer, so it is fixed
//! here rather than left implicit in the indexer: ASCII letters and digits,
//! lowercased, with everything else acting as a separator. Apostrophes split
//! (`don't` becomes `don` and `t`), which is wrong for English and right for
//! a spike — the alternative is a stemming and contraction policy, and that
//! is a search-quality decision to make against real queries, not a
//! substrate question.
//!
//! Each term is emitted with the kind of block it came from, because the
//! search plan ranks a match in a heading differently from one in a code
//! block. Weighting lives at query time; the index only records where a term
//! was found.

const std = @import("std");
const folio = @import("folio.zig");

/// The block kinds ranking distinguishes. Coarser than the block model on
/// purpose: what matters to a searcher is prominence, not construct.
pub const BlockKind = enum(u8) {
    heading,
    /// A document's name, as a synthetic block: the filename stem plus the
    /// first heading. Not content the writer typed in that position, but the
    /// strongest single statement of what a document is *about*, and until
    /// now entirely unsearchable — a file called `navigation-panels-plan.md`
    /// could not be found by searching for "navigation".
    title,
    paragraph,
    list_item,
    table_cell,
    code,
    quote,
    footnote,

    /// Baseline relevance multiplier.
    ///
    /// **Retuned against real prose (2026-08-29), and the original values
    /// were wrong for an instructive reason.** Headings were weighted 4.0
    /// back when scoring was raw term frequency, where a short heading and a
    /// long paragraph containing a term scored the same and the heading
    /// needed the lift. BM25 changed that: length normalization already
    /// rewards a term appearing in a six-word heading over the same term in a
    /// three-hundred-word paragraph. Keeping 4.0 on top double-counted, and
    /// on this repository's own planning documents it put two-word headings
    /// with a base score of 2.7 above substantive paragraphs scoring 8.7 —
    /// the title of a section outranking the section.
    ///
    /// So these are now modest adjustments to a scorer that already accounts
    /// for length, not compensation for one that does not.
    pub fn weight(self: BlockKind) f32 {
        return switch (self) {
            .title => 1.6,
            .heading => 1.5,
            .paragraph => 1.0,
            .list_item => 1.0,
            .table_cell => 0.9,
            .quote => 0.9,
            .footnote => 0.7,
            .code => 0.5,
        };
    }
};

pub const Token = struct {
    /// Lowercased, owned by the allocator passed to the tokenizer.
    text: []const u8,
    kind: BlockKind,
};

/// A link found in a block, for the backlink index.
pub const Link = struct {
    target: []const u8,
    kind: BlockKind,
};

pub const Harvest = struct {
    tokens: []const Token,
    links: []const Link,
    tags: []const []const u8,
};

const Collector = struct {
    gpa: std.mem.Allocator,
    tokens: std.ArrayList(Token) = .empty,
    links: std.ArrayList(Link) = .empty,
    tags: std.ArrayList([]const u8) = .empty,

    fn text(self: *Collector, s: []const u8, kind: BlockKind) !void {
        var start: ?usize = null;
        for (s, 0..) |c, i| {
            if (std.ascii.isAlphanumeric(c)) {
                if (start == null) start = i;
            } else if (start) |from| {
                try self.emit(s[from..i], kind);
                start = null;
            }
        }
        if (start) |from| try self.emit(s[from..], kind);
    }

    fn emit(self: *Collector, raw: []const u8, kind: BlockKind) !void {
        const lowered = try self.gpa.alloc(u8, raw.len);
        for (raw, lowered) |c, *o| o.* = std.ascii.toLower(c);
        try self.tokens.append(self.gpa, .{ .text = lowered, .kind = kind });
    }
};

/// Harvest every term, link and tag from one block. Allocations come from
/// `gpa`, which is expected to be a per-block arena.
pub fn harvest(gpa: std.mem.Allocator, block: folio.Block) !Harvest {
    var c = Collector{ .gpa = gpa };
    try walkBlock(&c, block, .paragraph);
    return .{
        .tokens = try c.tokens.toOwnedSlice(gpa),
        .links = try c.links.toOwnedSlice(gpa),
        .tags = try c.tags.toOwnedSlice(gpa),
    };
}

fn walkBlock(c: *Collector, block: folio.Block, inherited: BlockKind) error{OutOfMemory}!void {
    switch (block.body) {
        .heading => |h| try walkInlines(c, h.inline_content, .heading),
        .paragraph => |p| try walkInlines(c, p.inline_content, inherited),
        .code_block => |cb| {
            try c.text(cb.lang, .code);
            try c.text(cb.text, .code);
        },
        .horizontal_rule => {},
        .blockquote => |q| for (q.children) |child| try walkBlock(c, child, .quote),
        .footnote_definition => |f| {
            try c.text(f.label, .footnote);
            for (f.children) |child| try walkBlock(c, child, .footnote);
        },
        .bullet_list => |l| for (l.items) |item| {
            for (item.children) |child| try walkBlock(c, child, .list_item);
        },
        .ordered_list => |l| for (l.items) |item| {
            for (item.children) |child| try walkBlock(c, child, .list_item);
        },
        .table => |t| for (t.rows) |row| for (row) |cell| {
            try walkInlines(c, cell, .table_cell);
        },
    }
}

fn walkInlines(
    c: *Collector,
    inlines: []const folio.Inline,
    kind: BlockKind,
) error{OutOfMemory}!void {
    for (inlines) |node| {
        // A link's href is a reference, not prose: it feeds the backlink
        // index and is never indexed as terms, or every document would match
        // the words in its neighbours' filenames.
        if (node.marks().link) |link| {
            try c.links.append(c.gpa, .{ .target = link.href, .kind = kind });
        }
        switch (node) {
            .text => |t| try c.text(t.text, kind),
            .tag => |t| {
                try c.tags.append(c.gpa, t.name);
                // A tag is also searchable as a word, so `#draft` is found by
                // typing `draft`.
                try c.text(t.name, kind);
            },
            .image => |img| try c.text(img.alt, kind),
            .footnote_ref => |f| try c.text(f.label, .footnote),
            .line_break => {},
        }
    }
}
