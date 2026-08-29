//! Scoring.
//!
//! Kept apart from `search.zig` — retrieval finds the candidates, ranking
//! decides their order, and the whole open question about this engine is
//! whether the second part can be done better than a generic one. Mixing them
//! would make that impossible to measure.
//!
//! **BM25 is the floor, not the differentiator.** The comparison that matters
//! is Skrive-native signals against a strong generic baseline, so the baseline
//! has to actually be strong: the previous scorer used raw term frequency
//! times a block weight, which loses to `bm25()` on fundamentals and would
//! make any result uninterpretable. A loss has to mean "our signals do not
//! help", not "we forgot inverse document frequency".
//!
//! Every Skrive-specific signal is a separate, individually disableable term
//! on top of that floor, so the experiment can attribute a gain to a cause.

const std = @import("std");
const index_mod = @import("index.zig");
const tokenize = @import("tokenize.zig");

const Index = index_mod.Index;
const BlockRef = index_mod.BlockRef;
const TermId = index_mod.TermId;

/// Tunable weights. The plan puts ranking policy in the taste layer and passes
/// it into the engine as configuration, so these are data rather than
/// constants baked into the loop.
pub const Weights = struct {
    /// Term-frequency saturation. Standard BM25 territory is 1.2 to 2.0;
    /// lower saturates sooner, so a tenth mention counts for little more than
    /// a third.
    k1: f32 = 1.2,
    /// Length normalization, 0 to 1. At 0 a long block is not penalized at
    /// all; at 1 it is penalized in full proportion to its length.
    b: f32 = 0.75,

    /// Multiplier by block kind. A term in a heading is a stronger signal
    /// than the same term in a footnote, and a term in a code block is mostly
    /// an identifier.
    use_block_kind: bool = true,
    /// Blocks under a heading that also matches the query rank higher: the
    /// section is about the thing being searched for, not just mentioning it.
    heading_proximity: f32 = 0.35,
    /// Recently touched documents rank higher, decaying over this half-life.
    recency_half_life_days: f32 = 30.0,
    recency_weight: f32 = 0.20,
    /// Documents other documents point at are more likely to be the one being
    /// looked for.
    backlink_weight: f32 = 0.15,

    /// Everything off but the BM25 core. The control arm for measuring
    /// whether any of the above earns its place.
    pub const bm25_only: Weights = .{
        .use_block_kind = false,
        .heading_proximity = 0,
        .recency_weight = 0,
        .backlink_weight = 0,
    };
};

/// Per-query state that does not change across candidates, computed once.
pub const Context = struct {
    idx: *const Index,
    weights: Weights,
    average_length: f32,
    live_blocks: f32,
    /// Wall-clock now, for recency. Injected rather than read, so a ranked
    /// result set is reproducible in a test.
    now_millis: i64,

    pub fn init(idx: *const Index, weights: Weights, now_millis: i64) Context {
        return .{
            .idx = idx,
            .weights = weights,
            .average_length = idx.averageBlockLength(),
            .live_blocks = @floatFromInt(@max(idx.live_blocks, 1)),
            .now_millis = now_millis,
        };
    }

    /// Inverse document frequency, Robertson-Sparck-Jones form with the +1
    /// that keeps it non-negative for terms appearing in most blocks.
    ///
    /// This is the single most consequential thing the previous scorer was
    /// missing: without it a match on "the" counts as much as a match on the
    /// one distinctive word in the query.
    pub fn idf(self: Context, term: TermId) f32 {
        const n: f32 = @floatFromInt(self.idx.documentFrequency(term));
        return @log(1.0 + (self.live_blocks - n + 0.5) / (n + 0.5));
    }

    /// One term's BM25 contribution to one block.
    pub fn termScore(self: Context, term: TermId, block: BlockRef, freq: u32) f32 {
        const f: f32 = @floatFromInt(freq);
        const len: f32 = @floatFromInt(self.idx.blocks.items[block].length);
        const k1 = self.weights.k1;
        const b = self.weights.b;
        const norm = 1.0 - b + b * (len / @max(self.average_length, 1.0));
        return self.idf(term) * (f * (k1 + 1.0)) / (f + k1 * norm);
    }
};

/// Signals that apply to a whole candidate rather than to one term, applied
/// after the BM25 sum. Returned separately from the base score so the
/// benchmark can report what each contributed.
pub const Boost = struct {
    block_kind: f32 = 1.0,
    heading: f32 = 1.0,
    recency: f32 = 1.0,
    backlink: f32 = 1.0,

    pub fn product(self: Boost) f32 {
        return self.block_kind * self.heading * self.recency * self.backlink;
    }
};

/// Document-level facts the Skrive signals read. Supplied by the caller
/// because the index does not own document metadata yet — the block arena
/// that will hold it is B2 work the spike never built.
pub const DocFacts = struct {
    /// Last modification, or null when unknown.
    modified_millis: ?i64 = null,
    /// How many blocks elsewhere link to this document.
    inbound_links: u32 = 0,
};

pub fn boostFor(
    ctx: Context,
    block: BlockRef,
    facts: DocFacts,
    heading_matches: bool,
) Boost {
    const w = ctx.weights;
    var boost = Boost{};

    if (w.use_block_kind) {
        boost.block_kind = ctx.idx.blocks.items[block].kind.weight();
    }

    if (heading_matches and w.heading_proximity != 0) {
        boost.heading = 1.0 + w.heading_proximity;
    }

    if (w.recency_weight != 0) {
        if (facts.modified_millis) |modified| {
            const age_days = @as(f32, @floatFromInt(@max(ctx.now_millis - modified, 0))) /
                (1000.0 * 60.0 * 60.0 * 24.0);
            // Halve the bonus every half-life, so a year-old note is not
            // buried, only outranked by an equally good recent one.
            const decay = std.math.pow(f32, 0.5, age_days / @max(w.recency_half_life_days, 0.001));
            boost.recency = 1.0 + w.recency_weight * decay;
        }
    }

    if (w.backlink_weight != 0 and facts.inbound_links > 0) {
        // Saturating, because the tenth inbound link says much less than the
        // first and a hub should not swamp the ranking outright.
        const n: f32 = @floatFromInt(facts.inbound_links);
        boost.backlink = 1.0 + w.backlink_weight * (n / (n + 3.0));
    }

    return boost;
}
