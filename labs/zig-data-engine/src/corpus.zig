//! A synthetic writing corpus at controllable scale.
//!
//! The engine plan's central premise is that a personal corpus is small
//! enough to hold in RAM — tens of megabytes, tens of thousands of blocks.
//! Nothing in this lab can be measured honestly against the repository's
//! fixtures, which top out at 404K across 100 files. This generates the
//! corpus that premise describes.
//!
//! **The vocabulary is Zipf-distributed, and that is the point.** Search cost
//! is dominated by postings-list length, and in real prose a handful of words
//! appear everywhere while most appear once or twice. A corpus of uniformly
//! sampled words gives every term a short postings list and would make search
//! look fast for a reason that has nothing to do with the index. Words are
//! also built from syllables rather than random letters, so the vocabulary
//! clusters by prefix the way a real one does — which is what makes
//! prefix queries, the search-as-you-type path, behave realistically.
//!
//! **Every document is emitted twice**, once as `.folio` and once as `.md`,
//! from the same generated block tree. That makes the encoding the only
//! variable when the two index paths are compared: `.folio` blocks carry
//! stable ids and index incrementally, `.md` blocks key on `(path, ordinal)`
//! and re-index whole files.
//!
//! Generation is seeded and consults no clock, so a seed and a tier name
//! reproduce a corpus byte-for-byte.

const std = @import("std");
const folio = @import("folio.zig");

const Block = folio.Block;
const Inline = folio.Inline;
const ListItem = folio.ListItem;

pub const Tier = enum {
    /// Fast enough for a unit test.
    small,
    /// The shape of the repository's existing perf fixture.
    real,
    /// What the engine plan actually argues from.
    design,

    pub fn docs(self: Tier) usize {
        return switch (self) {
            .small => 20,
            .real => 100,
            .design => 2000,
        };
    }

    /// Scaled per tier rather than fixed, because a vocabulary the corpus
    /// exhausts is not a vocabulary. With a 30,000-word pool and 2.4M tokens
    /// even the rarest term lands seven times, leaving nothing that appears
    /// once, while real text is 40-60% such terms — and the tail is what the
    /// dictionary and prefix structures are sized against.
    ///
    /// The pools below are **deliberately larger than Heaps' law predicts**.
    /// The design tier yields roughly a 4.6% type-token ratio against real
    /// English prose's ~1%, so its dictionary is several times bigger than a
    /// natural corpus of the same length. That is a conservative error on
    /// purpose: it makes the dictionary and prefix search harder than
    /// reality rather than easier, which is the direction a gate should err.
    /// A fixed pool cannot reproduce both a realistic type-token ratio and a
    /// realistic singleton tail, because real vocabulary is generative rather
    /// than sampled; given the choice, this errs toward the harder corpus.
    pub fn vocabSize(self: Tier) usize {
        return switch (self) {
            .small => 3_000,
            .real => 20_000,
            .design => 120_000,
        };
    }
};

pub const Config = struct {
    seed: u64 = 0xc0ffee,
    docs: usize,
    vocab_size: usize = 5000,
    /// 1.0 is classic Zipf. Higher concentrates more mass on common words.
    zipf_exponent: f64 = 1.0,
    min_blocks: usize = 8,
    max_blocks: usize = 30,

    pub fn forTier(tier: Tier) Config {
        return .{ .docs = tier.docs(), .vocab_size = tier.vocabSize() };
    }
};

pub const Stats = struct {
    documents: usize = 0,
    blocks: usize = 0,
    words: usize = 0,
    links: usize = 0,
    tags: usize = 0,
    folio_bytes: usize = 0,
    markdown_bytes: usize = 0,
    /// Distinct vocabulary entries actually used.
    distinct_words: usize = 0,
};

// ---- vocabulary -----------------------------------------------------------

/// The most common English words, kept at the front so they receive the
/// heaviest Zipf weights. Real prose is mostly function words; a corpus
/// without them has an unrealistically flat term distribution.
const common_words = [_][]const u8{
    "the",   "of",    "and",   "to",     "a",       "in",     "that",  "is",
    "was",   "it",    "for",   "with",   "as",      "his",    "on",    "be",
    "at",    "by",    "not",   "this",   "had",     "are",    "but",   "from",
    "or",    "have",  "an",    "they",   "which",   "one",    "you",   "were",
    "her",   "all",   "she",   "there",  "would",   "their",  "we",    "him",
    "been",  "has",   "when",  "who",    "will",    "more",   "no",    "if",
    "out",   "so",    "said",  "what",   "up",      "its",    "about", "into",
    "than",  "them",  "can",   "only",   "other",   "new",    "some",  "could",
    "time",  "these", "two",   "may",    "then",    "do",     "first", "any",
    "my",    "now",   "such",  "like",   "our",     "over",   "man",   "me",
    "even",  "most",  "made",  "after",  "also",    "did",    "many",  "before",
    "must",  "well",  "back",  "through", "years",  "much",   "where", "your",
    "way",   "down",  "should", "because", "each",  "just",   "those", "how",
    "own",   "very",  "work",  "page",    "note",   "draft",  "idea",  "chapter",
};

const onsets = [_][]const u8{
    "b", "br", "c", "ch", "cl", "cr", "d", "dr", "f", "fl", "fr", "g",  "gl",
    "gr", "h", "j", "k", "l", "m", "n", "p", "pl", "pr", "qu", "r",    "s",
    "sc", "sh", "sl", "sm", "sn", "sp", "st", "str", "t", "th", "tr",  "v",
    "w", "wh", "y", "z",
};
const nuclei = [_][]const u8{
    "a", "e", "i", "o", "u", "ai", "ea", "ee", "ie", "oa", "oo", "ou", "au", "ei",
};
const codas = [_][]const u8{
    "", "b", "ck", "ct", "d", "ft", "g", "l", "ld", "lt", "m", "mp", "n",
    "nd", "ng", "nt", "p", "r", "rd", "rk", "rn", "rt", "s", "sh", "sk",
    "st", "t", "th", "x",
};

const Vocabulary = struct {
    words: [][]const u8,
    /// A small pool of distinctive terms used as tags. Drawn from the middle
    /// of the vocabulary rather than the Zipf head: real tags are chosen
    /// words that a writer reuses, not function words, and a corpus tagged
    /// `#the` would make tag-filtered retrieval meaningless to measure.
    tags: [][]const u8,
    /// Cumulative Zipf weights, parallel to `words`.
    cumulative: []f64,
    total: f64,

    fn build(arena: std.mem.Allocator, cfg: Config, rng: std.Random) !Vocabulary {
        const n = @max(cfg.vocab_size, common_words.len);
        const words = try arena.alloc([]const u8, n);

        for (common_words, 0..) |w, i| words[i] = w;

        var i = common_words.len;
        while (i < n) : (i += 1) {
            const syllables: usize = 1 + rng.uintLessThan(usize, 3);
            var buf: std.ArrayList(u8) = .empty;
            var s: usize = 0;
            while (s < syllables) : (s += 1) {
                try buf.appendSlice(arena, onsets[rng.uintLessThan(usize, onsets.len)]);
                try buf.appendSlice(arena, nuclei[rng.uintLessThan(usize, nuclei.len)]);
                try buf.appendSlice(arena, codas[rng.uintLessThan(usize, codas.len)]);
            }
            words[i] = try buf.toOwnedSlice(arena);
        }

        const cumulative = try arena.alloc(f64, n);
        var total: f64 = 0;
        for (0..n) |rank| {
            const w = 1.0 / std.math.pow(f64, @floatFromInt(rank + 1), cfg.zipf_exponent);
            total += w;
            cumulative[rank] = total;
        }

        const tag_count = @min(40, n / 4);
        const tags = try arena.alloc([]const u8, tag_count);
        for (tags, 0..) |*t, k| {
            // Spread across the mid-vocabulary, and make roughly a third
            // nested, which the schema allows and the tag panel cares about.
            const base = words[common_words.len + (k * 37) % (n - common_words.len)];
            const span = n - common_words.len;
            var parent_index = (k * 11 + 5) % span;
            if (parent_index == (k * 37) % span) parent_index = (parent_index + 1) % span;
            t.* = if (k % 3 == 0)
                try std.fmt.allocPrint(arena, "{s}/{s}", .{
                    words[common_words.len + parent_index],
                    base,
                })
            else
                base;
        }

        return .{ .words = words, .tags = tags, .cumulative = cumulative, .total = total };
    }

    fn sample(self: Vocabulary, rng: std.Random) usize {
        const target = rng.float(f64) * self.total;
        var lo: usize = 0;
        var hi: usize = self.cumulative.len - 1;
        while (lo < hi) {
            const mid = lo + (hi - lo) / 2;
            if (self.cumulative[mid] < target) lo = mid + 1 else hi = mid;
        }
        return lo;
    }
};

// ---- generation -----------------------------------------------------------

pub const Corpus = struct {
    /// Long-lived: owns the vocabulary and the distinct-word set, which
    /// outlive any single document.
    persistent: std.mem.Allocator,
    /// Per-document. The caller resets this between documents via
    /// `beginDocument`, because the whole corpus never needs to be resident
    /// at once and at the design tier it would not fit.
    arena: std.mem.Allocator,
    cfg: Config,
    prng: std.Random.Xoshiro256,
    vocab: Vocabulary,
    stats: Stats = .{},
    used: std.AutoHashMapUnmanaged(usize, void) = .empty,

    /// `persistent` owns the vocabulary and statistics for the whole run.
    pub fn init(persistent: std.mem.Allocator, cfg: Config) !Corpus {
        // Xoshiro256 named explicitly rather than DefaultPrng, so
        // reproducibility does not depend on what "default" means later.
        var prng = std.Random.Xoshiro256.init(cfg.seed);
        const vocab = try Vocabulary.build(persistent, cfg, prng.random());
        return .{
            .persistent = persistent,
            .arena = persistent,
            .cfg = cfg,
            .prng = prng,
            .vocab = vocab,
        };
    }

    /// Point document allocation at `arena`. The generator's random stream is
    /// untouched, so swapping arenas never changes what is generated.
    pub fn beginDocument(self: *Corpus, arena: std.mem.Allocator) void {
        self.arena = arena;
    }

    fn rng(self: *Corpus) std.Random {
        return self.prng.random();
    }

    fn word(self: *Corpus) ![]const u8 {
        const idx = self.vocab.sample(self.rng());
        try self.used.put(self.persistent, idx, {});
        self.stats.words += 1;
        return self.vocab.words[idx];
    }

    pub fn docSlug(arena: std.mem.Allocator, index: usize) ![]const u8 {
        return std.fmt.allocPrint(arena, "note-{d:0>5}", .{index});
    }

    /// A link target biased toward a few hubs, the way a real note graph is.
    fn linkTarget(self: *Corpus) usize {
        return self.vocab.sample(self.rng()) % self.cfg.docs;
    }

    fn sentence(self: *Corpus, out: *std.ArrayList(u8)) !void {
        const words = 6 + self.rng().uintLessThan(usize, 14);
        for (0..words) |i| {
            if (i != 0) try out.append(self.arena, ' ');
            const w = try self.word();
            if (i == 0) {
                try out.append(self.arena, std.ascii.toUpper(w[0]));
                try out.appendSlice(self.arena, w[1..]);
            } else {
                try out.appendSlice(self.arena, w);
            }
        }
        try out.append(self.arena, '.');
    }

    fn prose(self: *Corpus, sentences: usize) ![]const u8 {
        var out: std.ArrayList(u8) = .empty;
        for (0..sentences) |i| {
            if (i != 0) try out.append(self.arena, ' ');
            try self.sentence(&out);
        }
        return out.toOwnedSlice(self.arena);
    }

    fn phrase(self: *Corpus, words: usize) ![]const u8 {
        var out: std.ArrayList(u8) = .empty;
        for (0..words) |i| {
            if (i != 0) try out.append(self.arena, ' ');
            try out.appendSlice(self.arena, try self.word());
        }
        return out.toOwnedSlice(self.arena);
    }

    fn textRun(self: *Corpus, text: []const u8, marks: folio.Marks) !Inline {
        _ = self;
        return .{ .text = .{ .text = text, .marks = marks } };
    }

    /// A paragraph's inline run: prose, sometimes a mark, sometimes a link to
    /// another note, sometimes a tag.
    fn inlines(self: *Corpus) ![]const Inline {
        var out: std.ArrayList(Inline) = .empty;
        try out.append(self.arena, try self.textRun(try self.prose(1 + self.rng().uintLessThan(usize, 3)), .{}));

        const roll = self.rng().uintLessThan(usize, 100);
        if (roll < 25) {
            const marks: folio.Marks = switch (self.rng().uintLessThan(usize, 4)) {
                0 => .{ .strong = true },
                1 => .{ .em = true },
                2 => .{ .code = true },
                else => .{ .strikethrough = true },
            };
            try out.append(self.arena, try self.textRun(" ", .{}));
            try out.append(self.arena, try self.textRun(try self.phrase(2), marks));
        }
        if (roll >= 20 and roll < 40) {
            const target = self.linkTarget();
            const href = try std.fmt.allocPrint(self.arena, "{s}.md", .{try docSlug(self.arena, target)});
            try out.append(self.arena, try self.textRun(" ", .{}));
            try out.append(self.arena, try self.textRun(
                try self.phrase(2),
                .{ .link = .{ .href = href, .title = null } },
            ));
            self.stats.links += 1;
        }
        if (roll >= 90) {
            try out.append(self.arena, try self.textRun(" ", .{}));
            try out.append(self.arena, .{ .tag = .{
                .name = self.vocab.tags[self.rng().uintLessThan(usize, self.vocab.tags.len)],
                .marks = .{},
            } });
            self.stats.tags += 1;
        }
        try out.append(self.arena, try self.textRun(" ", .{}));
        try out.append(self.arena, try self.textRun(try self.prose(1 + self.rng().uintLessThan(usize, 4)), .{}));

        return out.toOwnedSlice(self.arena);
    }

    fn blockId(self: *Corpus) ![]const u8 {
        // The block-id alphabet from the schema's `^[0-9a-z]+$` grammar. It
        // trips the secret scanner's entropy heuristic for being 36 distinct
        // characters; it is a constant, not a credential.
        const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"; // noscan
        const buf = try self.arena.alloc(u8, 10);
        for (buf) |*c| c.* = alphabet[self.rng().uintLessThan(usize, alphabet.len)];
        return buf;
    }

    fn paragraph(self: *Corpus) !Block {
        return .{ .id = try self.blockId(), .body = .{ .paragraph = .{
            .inline_content = try self.inlines(),
        } } };
    }

    fn listItems(self: *Corpus, count: usize, checkable: bool) ![]const ListItem {
        const items = try self.arena.alloc(ListItem, count);
        for (items) |*item| {
            const children = try self.arena.alloc(Block, 1);
            children[0] = try self.paragraph();
            item.* = .{
                .spread = false,
                .checked = if (checkable) self.rng().boolean() else null,
                .children = children,
            };
        }
        return items;
    }

    fn block(self: *Corpus) !Block {
        const id = try self.blockId();
        return switch (self.rng().uintLessThan(usize, 100)) {
            0...11 => blk: {
                const level = 2 + self.rng().uintLessThan(usize, 3);
                const levels = [_][]const u8{ "1", "2", "3", "4", "5", "6" };
                const heading_inline = try self.arena.alloc(Inline, 1);
                heading_inline[0] = try self.textRun(try self.phrase(2 + self.rng().uintLessThan(usize, 4)), .{});
                break :blk .{ .id = id, .body = .{ .heading = .{
                    .level = levels[level - 1],
                    .inline_content = heading_inline,
                } } };
            },
            12...19 => .{ .id = id, .body = .{ .bullet_list = .{
                .spread = false,
                .items = try self.listItems(2 + self.rng().uintLessThan(usize, 5), self.rng().uintLessThan(usize, 4) == 0),
            } } },
            20...23 => .{ .id = id, .body = .{ .ordered_list = .{
                .start = "1",
                .spread = false,
                .items = try self.listItems(2 + self.rng().uintLessThan(usize, 4), false),
            } } },
            24...28 => .{ .id = id, .body = .{ .code_block = .{
                .lang = "ts",
                .meta = null,
                .text = try std.fmt.allocPrint(self.arena, "const {s} = {s};\n", .{
                    try self.word(),
                    try self.word(),
                }),
            } } },
            29...33 => blk: {
                const children = try self.arena.alloc(Block, 1);
                children[0] = try self.paragraph();
                break :blk .{ .id = id, .body = .{ .blockquote = .{ .children = children } } };
            },
            34...36 => .{ .id = id, .body = .horizontal_rule },
            37...39 => try self.table(id),
            else => try self.paragraph(),
        };
    }

    fn table(self: *Corpus, id: []const u8) !Block {
        const cols = 2 + self.rng().uintLessThan(usize, 3);
        const rows_count = 2 + self.rng().uintLessThan(usize, 4);

        const alignment = try self.arena.alloc(?folio.Align, cols);
        for (alignment) |*a| {
            a.* = switch (self.rng().uintLessThan(usize, 4)) {
                0 => .left,
                1 => .right,
                2 => .center,
                else => null,
            };
        }

        const rows = try self.arena.alloc([]const []const Inline, rows_count);
        for (rows) |*row| {
            const cells = try self.arena.alloc([]const Inline, cols);
            for (cells) |*cell| {
                const one = try self.arena.alloc(Inline, 1);
                one[0] = try self.textRun(try self.phrase(1 + self.rng().uintLessThan(usize, 3)), .{});
                cell.* = one;
            }
            row.* = cells;
        }

        return .{ .id = id, .body = .{ .table = .{
            .alignment = alignment,
            .widths = null,
            .rows = rows,
        } } };
    }

    /// One document. Deterministic given the corpus's position in the stream.
    pub fn document(self: *Corpus, index: usize) !folio.Document {
        const count = self.cfg.min_blocks +
            self.rng().uintLessThan(usize, self.cfg.max_blocks - self.cfg.min_blocks + 1);

        const blocks = try self.arena.alloc(Block, count + 1);
        const title = try self.phrase(2 + self.rng().uintLessThan(usize, 3));
        const title_inline = try self.arena.alloc(Inline, 1);
        title_inline[0] = try self.textRun(title, .{});
        blocks[0] = .{
            .id = try self.blockId(),
            .body = .{ .heading = .{ .level = "1", .inline_content = title_inline } },
        };
        for (blocks[1..]) |*slot| slot.* = try self.block();

        self.stats.documents += 1;
        self.stats.blocks += blocks.len;

        return .{
            .schema_version = "1",
            .doc_id = try std.fmt.allocPrint(self.arena, "01j9z{d:0>21}", .{index}),
            .meta = .{
                .title = title,
                .created_at = "2026-01-01T00:00:00.000Z",
                .extra = &.{},
            },
            .blocks = blocks,
        };
    }

    pub fn finish(self: *Corpus) Stats {
        var stats = self.stats;
        stats.distinct_words = self.used.count();
        return stats;
    }
};
