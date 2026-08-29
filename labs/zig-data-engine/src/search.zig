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

// ---- document-level results ------------------------------------------------

pub const BlockHit = struct {
    block: BlockRef,
    score: f32,
    base: f32,
    /// How many of the query's terms this block itself carries.
    matched_terms: u32,
};

pub const DocHit = struct {
    doc: index_mod.DocRef,
    score: f32,
    /// Best first. Owned.
    blocks: []BlockHit,
};

pub fn freeDocHits(gpa: std.mem.Allocator, hits: []DocHit) void {
    for (hits) |h| gpa.free(h.blocks);
    gpa.free(hits);
}

/// How much a document's second and subsequent matching blocks add.
///
/// Small, and **decaying**. A document that mentions the topic once in
/// exactly the right place should beat one that mentions it glancingly in
/// nine, so the best block has to dominate; but a document genuinely *about*
/// the topic should still edge out one that merely name-drops it, which is
/// what the tail contributes. Summing every block instead would rank by
/// length, which is the failure this whole aggregation exists to avoid.
///
/// A flat weight per extra block did not achieve that: four extras at 0.15
/// each add 60%, enough for five mediocre matches to beat one excellent one.
/// Decaying geometrically caps the tail near a third of the best block, so
/// the second match matters and the fifth barely does.
const secondary_weight: f32 = 0.15;
const secondary_decay: f32 = 0.6;
const secondary_blocks: usize = 4;

/// How much a document is discounted when its best block answers only part of
/// the query.
///
/// Terms being satisfiable across blocks is what makes real prose findable,
/// but taken alone it ranks a document whose best block matches half the
/// query above one whose best block matches all of it — which on this
/// repository's planning notes put a heading called "Typographic identity"
/// above the document actually about block identity, for the query "block
/// identity". A query answered in one place is a better answer than the same
/// terms scattered across a file.
///
/// The floor is deliberately generous rather than proportional: a document
/// that genuinely develops a subject across paragraphs should still compete,
/// only not win on a partial match alone.
const coverage_floor: f32 = 0.4;

/// The maximum number of query terms coverage can track, bounded by the bitset
/// used to record which terms a document has seen.
pub const max_query_terms = 64;

/// Search, returning documents with their matching blocks rather than a flat
/// list of blocks.
///
/// **Terms are satisfied across a document, not within a block.** A flat
/// block search is a strict conjunction, so "durability harness" only matches
/// where both words land in the same paragraph — which on real prose returns
/// almost nothing, because a writer introduces a subject in one paragraph and
/// develops it in the next. Requiring every term somewhere in the document,
/// and then ranking blocks within it by how much of the query they carry,
/// matches how documents are actually written.
///
/// It also fixes crowding: one long relevant document previously filled every
/// slot in the results.
pub fn runDocuments(
    idx: *const Index,
    gpa: std.mem.Allocator,
    query: Query,
    options: Options,
) ![]DocHit {
    const ctx = rank.Context.init(idx, options.weights, options.now_millis);

    var terms: std.ArrayList(TermId) = .empty;
    defer terms.deinit(gpa);
    var owned_union: ?[]Posting = null;
    defer if (owned_union) |u| gpa.free(u);

    var lists: std.ArrayList([]const Posting) = .empty;
    defer lists.deinit(gpa);

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
        var rarest = expansion[0];
        for (expansion) |candidate| {
            if (idx.documentFrequency(candidate) < idx.documentFrequency(rarest)) rarest = candidate;
        }
        try terms.append(gpa, rarest);
        try lists.append(gpa, owned_union.?);
    }

    if (lists.items.len == 0 or lists.items.len > max_query_terms) return &.{};
    const all_terms: u64 = if (lists.items.len == 64)
        std.math.maxInt(u64)
    else
        (@as(u64, 1) << @intCast(lists.items.len)) - 1;

    // Accumulate per block: the BM25 sum so far and which terms it carries.
    const Partial = struct { base: f32 = 0, mask: u64 = 0 };
    var partials: std.AutoArrayHashMapUnmanaged(BlockRef, Partial) = .empty;
    defer partials.deinit(gpa);

    for (lists.items, 0..) |list, term_index| {
        for (list) |posting| {
            const gop = try partials.getOrPut(gpa, posting.block);
            if (!gop.found_existing) gop.value_ptr.* = .{};
            gop.value_ptr.base += ctx.termScore(terms.items[term_index], posting.block, posting.freq);
            gop.value_ptr.mask |= @as(u64, 1) << @intCast(term_index);
        }
    }

    // Fold blocks into their documents, unioning coverage as we go.
    const DocAccum = struct { mask: u64 = 0, blocks: std.ArrayList(BlockHit) = .empty };
    var docs: std.AutoArrayHashMapUnmanaged(index_mod.DocRef, DocAccum) = .empty;
    defer {
        for (docs.values()) |*d| d.blocks.deinit(gpa);
        docs.deinit(gpa);
    }

    for (partials.keys(), partials.values()) |block, partial| {
        const info = idx.blocks.items[block];
        const facts = if (options.facts) |r| r.get(block) else defaultFacts(idx, block);
        const boost = rank.boostFor(ctx, block, facts, headingMatches(idx, terms.items, block));

        const gop = try docs.getOrPut(gpa, info.doc);
        if (!gop.found_existing) gop.value_ptr.* = .{};
        gop.value_ptr.mask |= partial.mask;
        try gop.value_ptr.blocks.append(gpa, .{
            .block = block,
            .score = partial.base * boost.product(),
            .base = partial.base,
            .matched_terms = @popCount(partial.mask),
        });
    }

    var hits: std.ArrayList(DocHit) = .empty;
    errdefer {
        for (hits.items) |h| gpa.free(h.blocks);
        hits.deinit(gpa);
    }

    for (docs.keys(), docs.values()) |doc, *accum| {
        if (accum.mask != all_terms) continue;

        std.mem.sort(BlockHit, accum.blocks.items, {}, struct {
            fn call(_: void, a: BlockHit, b: BlockHit) bool {
                if (a.matched_terms != b.matched_terms) return a.matched_terms > b.matched_terms;
                if (a.score != b.score) return a.score > b.score;
                return a.block < b.block;
            }
        }.call);

        const term_count: f32 = @floatFromInt(lists.items.len);
        const covered: f32 = @floatFromInt(accum.blocks.items[0].matched_terms);
        const concentration = coverage_floor + (1.0 - coverage_floor) * (covered / term_count);

        var score = accum.blocks.items[0].score * concentration;
        const tail = @min(accum.blocks.items.len, secondary_blocks + 1);
        var factor = secondary_weight;
        for (accum.blocks.items[1..tail]) |b| {
            score += factor * b.score;
            factor *= secondary_decay;
        }

        try hits.append(gpa, .{
            .doc = doc,
            .score = score,
            .blocks = try gpa.dupe(BlockHit, accum.blocks.items),
        });
    }

    std.mem.sort(DocHit, hits.items, {}, struct {
        fn call(_: void, a: DocHit, b: DocHit) bool {
            if (a.score != b.score) return a.score > b.score;
            return a.doc < b.doc;
        }
    }.call);

    if (options.limit != 0 and hits.items.len > options.limit) {
        for (hits.items[options.limit..]) |h| gpa.free(h.blocks);
        hits.shrinkRetainingCapacity(options.limit);
    }
    return hits.toOwnedSlice(gpa);
}
