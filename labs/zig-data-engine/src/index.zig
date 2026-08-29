//! The in-RAM inverted index.
//!
//! Three structures, all derived and all disposable: an interned dictionary,
//! postings per term, and a small table of block facts for ranking. None of
//! it is logged — it rebuilds from the blocks, so a bug here degrades a
//! feature and never destroys data.
//!
//! **Postings carry a frequency, not positions.** The search plan wants match
//! offsets for snippet highlighting, and storing every position would cost
//! roughly one word of memory per word of corpus to save re-scanning the ten
//! blocks actually shown. Offsets are recomputed from the matched block's own
//! text at display time, which is microseconds for a handful of blocks. This
//! is the trade the spike exists to make; if phrase search later needs
//! positions for intersection rather than display, that is the moment to
//! revisit it.
//!
//! **The dictionary is prefix-searchable by construction.** Search-as-you-type
//! makes the trailing token a prefix query, and a hash map cannot answer one.
//! Terms are kept in an array sorted by text, with newly interned terms held
//! in a small unsorted overlay that is merged when it grows — so a prefix
//! query binary-searches the sorted run and linearly scans the overlay,
//! rather than re-sorting the whole dictionary on every insert.

const std = @import("std");
const tokenize = @import("tokenize.zig");

const BlockKind = tokenize.BlockKind;
const Token = tokenize.Token;

pub const TermId = u32;
pub const BlockRef = u32;
pub const DocRef = u32;

pub const Posting = struct {
    block: BlockRef,
    freq: u32,
};

pub const BlockInfo = struct {
    doc: DocRef,
    kind: BlockKind,
};

/// One term's contribution to one block, kept sorted by term so the update
/// path can diff two of these with a merge walk.
const TermPost = struct {
    term: TermId,
    freq: u32,

    fn lessThan(_: void, a: TermPost, b: TermPost) bool {
        return a.term < b.term;
    }
};

pub const Index = struct {
    gpa: std.mem.Allocator,

    /// term id -> lowercased text, owned.
    terms: std.ArrayList([]const u8) = .empty,
    by_text: std.StringHashMapUnmanaged(TermId) = .empty,
    /// Term ids ordered by text. The prefix-query structure.
    sorted: std.ArrayList(TermId) = .empty,
    /// Interned since the last merge; scanned linearly by prefix queries.
    overlay: std.ArrayList(TermId) = .empty,

    /// term id -> postings, kept sorted by block so insert and remove are a
    /// binary search rather than a scan of a long list.
    postings: std.ArrayList(std.ArrayList(Posting)) = .empty,

    blocks: std.ArrayList(BlockInfo) = .empty,
    /// block -> its terms, sorted. The previous state an update diffs against.
    block_terms: std.ArrayList([]TermPost) = .empty,
    /// Which blocks are live; a removed block keeps its slot.
    block_live: std.ArrayList(bool) = .empty,

    /// target -> blocks that link to it.
    backlinks: std.StringHashMapUnmanaged(std.ArrayList(BlockRef)) = .empty,

    /// Overlay merges performed. Exposed so a test can assert it exercised
    /// the merge path rather than assuming the threshold was crossed.
    merges: usize = 0,

    pub fn init(gpa: std.mem.Allocator) Index {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *Index) void {
        for (self.terms.items) |t| self.gpa.free(t);
        self.terms.deinit(self.gpa);
        self.by_text.deinit(self.gpa);
        self.sorted.deinit(self.gpa);
        self.overlay.deinit(self.gpa);

        for (self.postings.items) |*p| p.deinit(self.gpa);
        self.postings.deinit(self.gpa);

        self.blocks.deinit(self.gpa);
        for (self.block_terms.items) |bt| self.gpa.free(bt);
        self.block_terms.deinit(self.gpa);
        self.block_live.deinit(self.gpa);

        var it = self.backlinks.iterator();
        while (it.next()) |entry| {
            self.gpa.free(entry.key_ptr.*);
            entry.value_ptr.deinit(self.gpa);
        }
        self.backlinks.deinit(self.gpa);

        self.* = undefined;
    }

    // ---- dictionary -------------------------------------------------------

    pub fn termCount(self: *const Index) usize {
        return self.terms.items.len;
    }

    /// Existing id, or a new one. The text is copied.
    pub fn intern(self: *Index, text: []const u8) !TermId {
        if (self.by_text.get(text)) |id| return id;

        const owned = try self.gpa.dupe(u8, text);
        errdefer self.gpa.free(owned);

        const id: TermId = @intCast(self.terms.items.len);
        try self.terms.append(self.gpa, owned);
        try self.by_text.put(self.gpa, owned, id);
        try self.postings.append(self.gpa, .empty);
        try self.overlay.append(self.gpa, id);

        if (self.overlay.items.len >= overlay_limit) try self.mergeOverlay();
        return id;
    }

    pub fn lookup(self: *const Index, text: []const u8) ?TermId {
        return self.by_text.get(text);
    }

    fn termLessThan(self: *const Index, a: TermId, b: TermId) bool {
        return std.mem.lessThan(u8, self.terms.items[a], self.terms.items[b]);
    }

    /// How large the unsorted overlay is allowed to get.
    ///
    /// A fixed cap rather than a fraction of the dictionary, because the two
    /// costs pull opposite ways: every prefix query scans the whole overlay,
    /// so it must stay small, while each merge touches the whole sorted run,
    /// so merging must stay rare. A fraction would let the overlay grow to
    /// tens of thousands of terms at corpus scale and put that scan on every
    /// keystroke. At 1024 the scan is negligible and the design tier merges
    /// on the order of a hundred times across a full build.
    const overlay_limit = 1024;

    /// Fold the overlay into the sorted run.
    ///
    /// Sorts the overlay and merges two ordered runs rather than re-sorting
    /// the concatenation: the sorted run is already ordered, and re-sorting
    /// it turns an O(n) merge into O(n log n) of string comparisons on every
    /// merge — which at a hundred merges over a hundred thousand terms is the
    /// difference between imperceptible and seconds.
    fn mergeOverlay(self: *Index) !void {
        const ctx = self;
        std.mem.sort(TermId, self.overlay.items, ctx, struct {
            fn call(c: *const Index, a: TermId, b: TermId) bool {
                return c.termLessThan(a, b);
            }
        }.call);

        const merged = try self.gpa.alloc(TermId, self.sorted.items.len + self.overlay.items.len);
        errdefer self.gpa.free(merged);

        var i: usize = 0;
        var j: usize = 0;
        var w: usize = 0;
        while (i < self.sorted.items.len and j < self.overlay.items.len) : (w += 1) {
            if (self.termLessThan(self.overlay.items[j], self.sorted.items[i])) {
                merged[w] = self.overlay.items[j];
                j += 1;
            } else {
                merged[w] = self.sorted.items[i];
                i += 1;
            }
        }
        while (i < self.sorted.items.len) : ({ i += 1; w += 1; }) merged[w] = self.sorted.items[i];
        while (j < self.overlay.items.len) : ({ j += 1; w += 1; }) merged[w] = self.overlay.items[j];

        self.sorted.clearRetainingCapacity();
        try self.sorted.appendSlice(self.gpa, merged);
        self.gpa.free(merged);
        self.overlay.clearRetainingCapacity();
        self.merges += 1;
    }

    /// Every term starting with `prefix`. Caller owns the result.
    ///
    /// Uncapped on purpose: a one-character prefix legitimately matches
    /// thousands of terms, and capping here would hide that cost from the
    /// measurement rather than pay it.
    pub fn prefixTerms(self: *const Index, gpa: std.mem.Allocator, prefix: []const u8) ![]TermId {
        var out: std.ArrayList(TermId) = .empty;
        errdefer out.deinit(gpa);

        // Binary search for the first sorted term at or after the prefix.
        var lo: usize = 0;
        var hi: usize = self.sorted.items.len;
        while (lo < hi) {
            const mid = lo + (hi - lo) / 2;
            if (std.mem.lessThan(u8, self.terms.items[self.sorted.items[mid]], prefix)) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        while (lo < self.sorted.items.len) : (lo += 1) {
            const id = self.sorted.items[lo];
            if (!std.mem.startsWith(u8, self.terms.items[id], prefix)) break;
            try out.append(gpa, id);
        }

        for (self.overlay.items) |id| {
            if (std.mem.startsWith(u8, self.terms.items[id], prefix)) try out.append(gpa, id);
        }

        std.mem.sort(TermId, out.items, {}, std.sort.asc(TermId));
        return out.toOwnedSlice(gpa);
    }

    // ---- postings ---------------------------------------------------------

    /// Index of `block` in `list`, or where it would be inserted.
    fn postingSlot(list: []const Posting, block: BlockRef) usize {
        var lo: usize = 0;
        var hi: usize = list.len;
        while (lo < hi) {
            const mid = lo + (hi - lo) / 2;
            if (list[mid].block < block) lo = mid + 1 else hi = mid;
        }
        return lo;
    }

    fn addPosting(self: *Index, term: TermId, block: BlockRef, freq: u32) !void {
        const list = &self.postings.items[term];
        const slot = postingSlot(list.items, block);
        if (slot < list.items.len and list.items[slot].block == block) {
            list.items[slot].freq = freq;
            return;
        }
        try list.insert(self.gpa, slot, .{ .block = block, .freq = freq });
    }

    fn removePosting(self: *Index, term: TermId, block: BlockRef) void {
        const list = &self.postings.items[term];
        const slot = postingSlot(list.items, block);
        if (slot < list.items.len and list.items[slot].block == block) {
            _ = list.orderedRemove(slot);
        }
    }

    pub fn postingsFor(self: *const Index, term: TermId) []const Posting {
        return self.postings.items[term].items;
    }

    // ---- blocks -----------------------------------------------------------

    pub fn blockCount(self: *const Index) usize {
        return self.blocks.items.len;
    }

    fn ensureBlock(self: *Index, ref: BlockRef) !void {
        while (self.blocks.items.len <= ref) {
            try self.blocks.append(self.gpa, .{ .doc = 0, .kind = .paragraph });
            try self.block_terms.append(self.gpa, &.{});
            try self.block_live.append(self.gpa, false);
        }
    }

    /// Insert or update a block. Only the terms whose membership or frequency
    /// actually changed are touched — the property that makes re-indexing a
    /// saved block cheap rather than proportional to the document.
    pub fn putBlock(
        self: *Index,
        ref: BlockRef,
        info: BlockInfo,
        tokens: []const Token,
    ) !void {
        try self.ensureBlock(ref);

        var next: std.ArrayList(TermPost) = .empty;
        errdefer next.deinit(self.gpa);
        for (tokens) |token| {
            try next.append(self.gpa, .{ .term = try self.intern(token.text), .freq = 1 });
        }
        std.mem.sort(TermPost, next.items, {}, TermPost.lessThan);

        // Collapse repeats into frequencies.
        var write: usize = 0;
        var read: usize = 0;
        while (read < next.items.len) {
            const term = next.items[read].term;
            var freq: u32 = 0;
            while (read < next.items.len and next.items[read].term == term) : (read += 1) freq += 1;
            next.items[write] = .{ .term = term, .freq = freq };
            write += 1;
        }
        next.shrinkRetainingCapacity(write);

        const previous = self.block_terms.items[ref];
        var old_i: usize = 0;
        var new_i: usize = 0;
        while (old_i < previous.len or new_i < next.items.len) {
            if (new_i == next.items.len or
                (old_i < previous.len and previous[old_i].term < next.items[new_i].term))
            {
                self.removePosting(previous[old_i].term, ref);
                old_i += 1;
            } else if (old_i == previous.len or next.items[new_i].term < previous[old_i].term) {
                try self.addPosting(next.items[new_i].term, ref, next.items[new_i].freq);
                new_i += 1;
            } else {
                // Present in both: only write when the count actually moved.
                if (previous[old_i].freq != next.items[new_i].freq) {
                    try self.addPosting(next.items[new_i].term, ref, next.items[new_i].freq);
                }
                old_i += 1;
                new_i += 1;
            }
        }

        self.gpa.free(previous);
        self.block_terms.items[ref] = try next.toOwnedSlice(self.gpa);
        self.blocks.items[ref] = info;
        self.block_live.items[ref] = true;
    }

    pub fn removeBlock(self: *Index, ref: BlockRef) !void {
        if (ref >= self.blocks.items.len or !self.block_live.items[ref]) return;
        for (self.block_terms.items[ref]) |tp| self.removePosting(tp.term, ref);
        self.gpa.free(self.block_terms.items[ref]);
        self.block_terms.items[ref] = &.{};
        self.block_live.items[ref] = false;
    }

    pub fn addBacklink(self: *Index, target: []const u8, from: BlockRef) !void {
        const gop = try self.backlinks.getOrPut(self.gpa, target);
        if (!gop.found_existing) {
            gop.key_ptr.* = try self.gpa.dupe(u8, target);
            gop.value_ptr.* = .empty;
        }
        try gop.value_ptr.append(self.gpa, from);
    }

    pub fn backlinksTo(self: *const Index, target: []const u8) []const BlockRef {
        const entry = self.backlinks.get(target) orelse return &.{};
        return entry.items;
    }

    /// A deterministic rendering of the index's meaningful state, for
    /// comparing an incrementally updated index against a freshly built one.
    ///
    /// Terms with no postings are omitted deliberately. Interning is
    /// one-way, so a term whose last posting was removed lingers in the
    /// dictionary of an incrementally updated index and never exists in a
    /// rebuilt one. That difference is invisible to every query, and holding
    /// the two to it would be asserting on garbage-collection policy rather
    /// than on what the index answers.
    pub fn dump(self: *const Index, gpa: std.mem.Allocator) ![]u8 {
        var live: std.ArrayList(TermId) = .empty;
        defer live.deinit(gpa);
        for (0..self.terms.items.len) |id| {
            if (self.postings.items[id].items.len != 0) try live.append(gpa, @intCast(id));
        }

        std.mem.sort(TermId, live.items, self, struct {
            fn call(ctx: *const Index, a: TermId, b: TermId) bool {
                return ctx.termLessThan(a, b);
            }
        }.call);

        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        for (live.items) |id| {
            try out.appendSlice(gpa, self.terms.items[id]);
            for (self.postings.items[id].items) |p| {
                var buf: [32]u8 = undefined;
                const s = std.fmt.bufPrint(&buf, " {d}:{d}", .{ p.block, p.freq }) catch unreachable;
                try out.appendSlice(gpa, s);
            }
            try out.append(gpa, '\n');
        }
        return out.toOwnedSlice(gpa);
    }
};
