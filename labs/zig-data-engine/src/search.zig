//! Querying the index.
//!
//! A query is a conjunction: every complete term must be present, and the
//! trailing token — the one still being typed — matches as a prefix. That
//! shape comes from the search plan's search-as-you-type requirement, where
//! results must repaint within a frame of the keystroke rather than after a
//! submit.

const std = @import("std");
const index_mod = @import("index.zig");
const rank = @import("rank.zig");
const tokenize = @import("tokenize.zig");

const Index = index_mod.Index;
const BlockRef = index_mod.BlockRef;
const Posting = index_mod.Posting;
const TermId = index_mod.TermId;

pub const Hit = struct {
    block: BlockRef,
    score: f32,
    /// The BM25 sum before Skrive-specific boosts, kept so an experiment can
    /// see what the signals actually moved rather than only the total.
    base: f32 = 0,
};

/// What the caller knows about documents that the index does not. Optional:
/// with no resolver, recency and backlink boosts simply do not fire, which is
/// also how the BM25-only control arm runs.
pub const FactsResolver = struct {
    ptr: *anyopaque,
    lookup: *const fn (ptr: *anyopaque, block: BlockRef) rank.DocFacts,

    pub inline fn get(self: FactsResolver, block: BlockRef) rank.DocFacts {
        return self.lookup(self.ptr, block);
    }
};

pub const Options = struct {
    weights: rank.Weights = .{},
    now_millis: i64 = 0,
    facts: ?FactsResolver = null,
    /// Stop after this many results. Retrieval still scans the candidate
    /// list, but nothing beyond the cut is kept or sorted — which is what
    /// makes a one-character prefix affordable.
    limit: usize = 0,
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
    return runWith(idx, gpa, query, .{});
}

pub fn runWith(
    idx: *const Index,
    gpa: std.mem.Allocator,
    query: Query,
    options: Options,
) ![]Hit {
    const ctx = rank.Context.init(idx, options.weights, options.now_millis);
    // Term ids run parallel to the postings lists, because scoring needs the
    // term to compute its inverse document frequency.
    var terms: std.ArrayList(TermId) = .empty;
    defer terms.deinit(gpa);
    var lists: std.ArrayList([]const Posting) = .empty;
    defer {
        // Only the prefix union is owned; term postings belong to the index.
        lists.deinit(gpa);
    }

    var owned_union: ?[]Posting = null;
    defer if (owned_union) |u| gpa.free(u);

    for (query.terms) |term| {
        const id = idx.lookup(term) orelse return &.{};
        try terms.append(gpa, id);
        try lists.append(gpa, idx.postingsFor(id));
    }

    if (query.prefix) |prefix| {
        const expansion = try idx.prefixTerms(gpa, prefix);
        defer gpa.free(expansion);
        if (expansion.len == 0) return &.{};
        owned_union = try unionPostings(idx, gpa, expansion);
        // A prefix union has no single term, so it is scored against the
        // rarest expansion it merged: the closest honest stand-in for "what
        // the user is about to finish typing".
        var rarest = expansion[0];
        for (expansion) |candidate| {
            if (idx.documentFrequency(candidate) < idx.documentFrequency(rarest)) rarest = candidate;
        }
        try terms.append(gpa, rarest);
        try lists.append(gpa, owned_union.?);
    }

    if (lists.items.len == 0) return &.{};

    // Intersect starting from the shortest list, so the walk is bounded by
    // the rarest term rather than the commonest. Terms travel with their
    // lists so scoring can still name the term behind each posting.
    var order = try gpa.alloc(usize, lists.items.len);
    defer gpa.free(order);
    for (order, 0..) |*slot, i| slot.* = i;
    std.mem.sort(usize, order, lists.items, struct {
        fn call(ls: []const []const Posting, a: usize, b: usize) bool {
            return ls[a].len < ls[b].len;
        }
    }.call);

    var hits: std.ArrayList(Hit) = .empty;
    errdefer hits.deinit(gpa);

    const seed_list = lists.items[order[0]];
    outer: for (seed_list) |seed| {
        var base = ctx.termScore(terms.items[order[0]], seed.block, seed.freq);
        for (order[1..]) |i| {
            const found = find(lists.items[i], seed.block) orelse continue :outer;
            base += ctx.termScore(terms.items[i], seed.block, found.freq);
        }

        const facts = if (options.facts) |r| r.get(seed.block) else defaultFacts(idx, seed.block);
        const boost = rank.boostFor(ctx, seed.block, facts, headingMatches(idx, terms.items, seed.block));
        try hits.append(gpa, .{
            .block = seed.block,
            .score = base * boost.product(),
            .base = base,
        });
    }

    std.mem.sort(Hit, hits.items, {}, struct {
        fn call(_: void, a: Hit, b: Hit) bool {
            if (a.score != b.score) return a.score > b.score;
            return a.block < b.block;
        }
    }.call);

    if (options.limit != 0 and hits.items.len > options.limit) {
        hits.shrinkRetainingCapacity(options.limit);
    }
    return hits.toOwnedSlice(gpa);
}

/// Document facts straight from the index, when the caller supplies no
/// resolver of its own. A vault load fills these in; a synthetic corpus
/// leaves them neutral.
fn defaultFacts(idx: *const Index, block: BlockRef) rank.DocFacts {
    const doc_ref = idx.blocks.items[block].doc;
    if (doc_ref >= idx.docs.items.len) return .{};
    const doc = idx.docs.items[doc_ref];
    return .{
        .modified_millis = if (doc.modified_millis == 0) null else doc.modified_millis,
        .inbound_links = doc.inbound,
    };
}

/// Does the heading this block sits under also match the query?
///
/// Any query term is enough, deliberately. The signal being reached for is
/// "this section is about the thing you asked for", and a heading rarely
/// contains a whole query — a section called "Durability" should lift its
/// paragraphs for the query "durability harness" even though it never says
/// "harness".
fn headingMatches(idx: *const Index, terms: []const TermId, block: BlockRef) bool {
    const heading = idx.blocks.items[block].heading;
    if (heading == index_mod.no_heading) return false;
    for (terms) |term| {
        if (find(idx.postingsFor(term), heading) != null) return true;
    }
    return false;
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
