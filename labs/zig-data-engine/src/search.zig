//! Querying the index.
//!
//! A query is a conjunction: every complete term must be present, and the
//! trailing token — the one still being typed — matches as a prefix. That
//! shape comes from the search plan's search-as-you-type requirement, where
//! results must repaint within a frame of the keystroke rather than after a
//! submit.

const std = @import("std");
const index_mod = @import("index.zig");
const tokenize = @import("tokenize.zig");

const Index = index_mod.Index;
const BlockRef = index_mod.BlockRef;
const Posting = index_mod.Posting;
const TermId = index_mod.TermId;

pub const Hit = struct {
    block: BlockRef,
    score: f32,
};

pub const Query = struct {
    /// Complete terms, all required.
    terms: []const []const u8,
    /// The token still being typed, matched as a prefix. Null when the text
    /// ends on a separator, which is the user having finished the word.
    prefix: ?[]const u8,
};

/// Split query text the same way block text is split, then treat the last
/// token as a prefix unless the text ends on a separator.
pub fn parseQuery(gpa: std.mem.Allocator, text: []const u8) !Query {
    var words: std.ArrayList([]const u8) = .empty;
    errdefer words.deinit(gpa);

    var start: ?usize = null;
    for (text, 0..) |c, i| {
        if (std.ascii.isAlphanumeric(c)) {
            if (start == null) start = i;
        } else if (start) |from| {
            try words.append(gpa, try lower(gpa, text[from..i]));
            start = null;
        }
    }
    if (start) |from| try words.append(gpa, try lower(gpa, text[from..]));

    const ends_open = text.len != 0 and std.ascii.isAlphanumeric(text[text.len - 1]);
    if (ends_open and words.items.len != 0) {
        const prefix = words.items[words.items.len - 1];
        words.shrinkRetainingCapacity(words.items.len - 1);
        return .{ .terms = try words.toOwnedSlice(gpa), .prefix = prefix };
    }
    return .{ .terms = try words.toOwnedSlice(gpa), .prefix = null };
}

fn lower(gpa: std.mem.Allocator, raw: []const u8) ![]const u8 {
    const out = try gpa.alloc(u8, raw.len);
    for (raw, out) |c, *o| o.* = std.ascii.toLower(c);
    return out;
}

/// Run a query. Results are ordered by descending score, ties broken by block
/// so the ordering is total and reproducible.
pub fn run(idx: *const Index, gpa: std.mem.Allocator, query: Query) ![]Hit {
    var lists: std.ArrayList([]const Posting) = .empty;
    defer {
        // Only the prefix union is owned; term postings belong to the index.
        lists.deinit(gpa);
    }

    var owned_union: ?[]Posting = null;
    defer if (owned_union) |u| gpa.free(u);

    for (query.terms) |term| {
        const id = idx.lookup(term) orelse return &.{};
        lists.append(gpa, idx.postingsFor(id)) catch |e| return e;
    }

    if (query.prefix) |prefix| {
        const expansion = try idx.prefixTerms(gpa, prefix);
        defer gpa.free(expansion);
        if (expansion.len == 0) return &.{};
        owned_union = try unionPostings(idx, gpa, expansion);
        try lists.append(gpa, owned_union.?);
    }

    if (lists.items.len == 0) return &.{};

    // Intersect starting from the shortest list, so the walk is bounded by
    // the rarest term rather than the commonest.
    std.mem.sort([]const Posting, lists.items, {}, struct {
        fn call(_: void, a: []const Posting, b: []const Posting) bool {
            return a.len < b.len;
        }
    }.call);

    var hits: std.ArrayList(Hit) = .empty;
    errdefer hits.deinit(gpa);

    outer: for (lists.items[0]) |seed| {
        var score: f32 = weightOf(idx, seed.block) * @as(f32, @floatFromInt(seed.freq));
        for (lists.items[1..]) |list| {
            const found = find(list, seed.block) orelse continue :outer;
            score += weightOf(idx, seed.block) * @as(f32, @floatFromInt(found.freq));
        }
        try hits.append(gpa, .{ .block = seed.block, .score = score });
    }

    std.mem.sort(Hit, hits.items, {}, struct {
        fn call(_: void, a: Hit, b: Hit) bool {
            if (a.score != b.score) return a.score > b.score;
            return a.block < b.block;
        }
    }.call);

    return hits.toOwnedSlice(gpa);
}

fn weightOf(idx: *const Index, block: BlockRef) f32 {
    return idx.blocks.items[block].kind.weight();
}

fn find(list: []const Posting, block: BlockRef) ?Posting {
    var lo: usize = 0;
    var hi: usize = list.len;
    while (lo < hi) {
        const mid = lo + (hi - lo) / 2;
        if (list[mid].block < block) lo = mid + 1 else hi = mid;
    }
    if (lo < list.len and list[lo].block == block) return list[lo];
    return null;
}

/// Merge the postings of every expansion of a prefix into one sorted list,
/// summing frequencies so a block matching several expansions ranks higher.
fn unionPostings(idx: *const Index, gpa: std.mem.Allocator, terms: []const TermId) ![]Posting {
    var totals: std.AutoArrayHashMapUnmanaged(BlockRef, u32) = .empty;
    defer totals.deinit(gpa);

    for (terms) |term| {
        for (idx.postingsFor(term)) |p| {
            const gop = try totals.getOrPut(gpa, p.block);
            if (!gop.found_existing) gop.value_ptr.* = 0;
            gop.value_ptr.* += p.freq;
        }
    }

    const out = try gpa.alloc(Posting, totals.count());
    errdefer gpa.free(out);
    for (totals.keys(), totals.values(), out) |block, freq, *slot| {
        slot.* = .{ .block = block, .freq = freq };
    }
    std.mem.sort(Posting, out, {}, struct {
        fn call(_: void, a: Posting, b: Posting) bool {
            return a.block < b.block;
        }
    }.call);
    return out;
}
