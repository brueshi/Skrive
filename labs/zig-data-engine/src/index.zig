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

/// `extern` so the layout is guaranteed and a snapshot can restore a whole
/// postings list with one copy instead of reading two integers at a time.
pub const Posting = extern struct {
    block: BlockRef,
    freq: u32,
};

/// No enclosing heading. A sentinel rather than an optional so the block
/// table stays a flat array of fixed-size records.
pub const no_heading: BlockRef = std.math.maxInt(BlockRef);

pub const DocInfo = struct {
    /// Owned, relative to the vault root.
    path: []const u8,
    modified_millis: i64,
    /// Total tokens across the document's blocks, for document-level length
    /// normalization.
    length: u64 = 0,
    /// Blocks elsewhere that link here. Resolved after a load, since a link
    /// may point at a document not yet walked.
    inbound: u32 = 0,
};

pub const BlockInfo = struct {
    doc: DocRef,
    kind: BlockKind,
    /// The heading this block sits under, or `no_heading`.
    heading: BlockRef = no_heading,
    /// Token count, for length normalization. A term appearing once in a
    /// six-word heading means more than the same term once in a
    /// three-hundred-word block, and a scorer without this systematically
    /// prefers long blocks for no better reason than that they contain more
    /// words.
    length: u32 = 0,
};

/// One term's contribution to one block, kept sorted by term so the update
/// path can diff two of these with a merge walk.
pub const TermPost = extern struct {
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

    /// Live block count and total token count, maintained incrementally so
    /// average block length is available at query time without a scan.
    live_blocks: usize = 0,
    total_tokens: u64 = 0,

    docs: std.ArrayList(DocInfo) = .empty,
    by_path: std.StringHashMapUnmanaged(DocRef) = .empty,

    /// Original text of heading blocks, for breadcrumbs. Only headings are
    /// kept: the index otherwise stores terms rather than text, and a
    /// breadcrumb rebuilt from lowercased tokens reads like a ransom note.
    /// Headings are few and short, so this costs almost nothing.
    heading_labels: std.AutoHashMapUnmanaged(BlockRef, []const u8) = .empty,

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

        for (self.docs.items) |d| self.gpa.free(d.path);
        self.docs.deinit(self.gpa);
        self.by_path.deinit(self.gpa);

        var labels = self.heading_labels.valueIterator();
        while (labels.next()) |v| self.gpa.free(v.*);
        self.heading_labels.deinit(self.gpa);

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

    /// How many live blocks contain this term. The other half of IDF.
    pub fn documentFrequency(self: *const Index, term: TermId) usize {
        return self.postings.items[term].items.len;
    }

    /// Mean document length in tokens.
    pub fn averageDocumentLength(self: *const Index) f32 {
        if (self.docs.items.len == 0) return 1.0;
        return @as(f32, @floatFromInt(self.total_tokens)) /
            @as(f32, @floatFromInt(self.docs.items.len));
    }

    /// Mean block length in tokens, for length normalization.
    pub fn averageBlockLength(self: *const Index) f32 {
        if (self.live_blocks == 0) return 1.0;
        return @as(f32, @floatFromInt(self.total_tokens)) /
            @as(f32, @floatFromInt(self.live_blocks));
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

        var stored = info;
        stored.length = @intCast(tokens.len);
        if (!self.block_live.items[ref]) self.live_blocks += 1;
        const previous_length = self.blocks.items[ref].length;
        self.total_tokens = self.total_tokens - previous_length + stored.length;
        if (stored.doc < self.docs.items.len) {
            const d = &self.docs.items[stored.doc];
            d.length = d.length + stored.length - previous_length;
        }
        self.blocks.items[ref] = stored;
        self.block_live.items[ref] = true;
    }

    pub fn removeBlock(self: *Index, ref: BlockRef) !void {
        if (ref >= self.blocks.items.len or !self.block_live.items[ref]) return;
        for (self.block_terms.items[ref]) |tp| self.removePosting(tp.term, ref);
        self.gpa.free(self.block_terms.items[ref]);
        self.block_terms.items[ref] = &.{};
        self.block_live.items[ref] = false;
        self.live_blocks -= 1;
        self.total_tokens -= self.blocks.items[ref].length;
        const doc_ref = self.blocks.items[ref].doc;
        if (doc_ref < self.docs.items.len) {
            self.docs.items[doc_ref].length -= self.blocks.items[ref].length;
        }
        self.blocks.items[ref].length = 0;
    }

    /// Register a document, or return the existing ref for a path already
    /// seen. Paths are the identity here because `.md` has no `docId`; a
    /// `.folio` vault would key on the id in the file instead.
    pub fn addDocument(self: *Index, path: []const u8, modified_millis: i64) !DocRef {
        if (self.by_path.get(path)) |existing| return existing;

        const owned = try self.gpa.dupe(u8, path);
        errdefer self.gpa.free(owned);
        const ref: DocRef = @intCast(self.docs.items.len);
        try self.docs.append(self.gpa, .{ .path = owned, .modified_millis = modified_millis });
        try self.by_path.put(self.gpa, owned, ref);
        return ref;
    }

    /// Record a heading's text as authored, trimmed of its leading hashes.
    pub fn setHeadingLabel(self: *Index, ref: BlockRef, text: []const u8) !void {
        var label = std.mem.trim(u8, text, " \t\r\n");
        label = std.mem.trimStart(u8, label, "#");
        label = std.mem.trim(u8, label, " \t");

        const gop = try self.heading_labels.getOrPut(self.gpa, ref);
        if (gop.found_existing) self.gpa.free(gop.value_ptr.*);
        gop.value_ptr.* = try self.gpa.dupe(u8, label);
    }

    /// The heading a block sits under, as authored, or null.
    pub fn breadcrumb(self: *const Index, block: BlockRef) ?[]const u8 {
        const info = self.blocks.items[block];
        const heading = if (info.kind == .heading) block else info.heading;
        if (heading == no_heading) return null;
        return self.heading_labels.get(heading);
    }

    pub fn document(self: *const Index, ref: DocRef) DocInfo {
        return self.docs.items[ref];
    }

    /// Count inbound links per document, once every path is known.
    ///
    /// A link target is written as it appeared in the source, so it is
    /// matched by suffix against known paths rather than resolved: a note
    /// linking to `note-7.md` from a sibling directory means the same file a
    /// link to `folder/note-7.md` means, and neither spelling should be lost
    /// because it did not match a string exactly.
    pub fn resolveInboundLinks(self: *Index) !void {
        for (self.docs.items) |*d| d.inbound = 0;

        var it = self.backlinks.iterator();
        while (it.next()) |entry| {
            const target = entry.key_ptr.*;
            const count: u32 = @intCast(entry.value_ptr.items.len);
            if (self.by_path.get(target)) |exact| {
                self.docs.items[exact].inbound += count;
                continue;
            }
            for (self.docs.items) |*d| {
                if (std.mem.endsWith(u8, d.path, target)) {
                    d.inbound += count;
                    break;
                }
            }
        }
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

    /// Release the unused capacity growable containers accumulate.
    ///
    /// Postings lists grow geometrically, so after a bulk build roughly a
    /// third of the postings memory is capacity nobody asked for — 11MB of a
    /// 53MB index at design scale. This gives it back. Call it when a build
    /// settles, not between edits: an append to a shrunk list reallocates, so
    /// doing this constantly trades memory for churn in the other direction.
    pub fn shrinkToFit(self: *Index) void {
        for (self.postings.items) |*list| {
            if (list.capacity > list.items.len) {
                list.shrinkAndFree(self.gpa, list.items.len);
            }
        }
    }

    /// Where the index's memory actually goes.
    ///
    /// The engine plan's central premise is that a personal corpus fits in
    /// RAM comfortably, and that premise is what makes a bespoke in-memory
    /// engine reasonable rather than reckless. It is also the one claim the
    /// spike measured nothing about. This counts the structures exactly
    /// rather than sampling the process, so the answer says *which* structure
    /// to attack when the total is too large.
    ///
    /// Slack is reported apart from live bytes because growable containers
    /// over-allocate, and a number that hides the difference cannot tell an
    /// oversized design from an oversized allocation strategy.
    pub const Footprint = struct {
        term_text: usize = 0,
        term_table: usize = 0,
        dictionary_order: usize = 0,
        dictionary_hash: usize = 0,
        postings_live: usize = 0,
        postings_slack: usize = 0,
        postings_headers: usize = 0,
        block_table: usize = 0,
        block_terms: usize = 0,
        backlinks: usize = 0,

        pub fn total(self: Footprint) usize {
            return self.term_text + self.term_table + self.dictionary_order +
                self.dictionary_hash + self.postings_live + self.postings_slack +
                self.postings_headers + self.block_table + self.block_terms +
                self.backlinks;
        }
    };

    pub fn footprint(self: *const Index) Footprint {
        var f = Footprint{};

        for (self.terms.items) |t| f.term_text += t.len;
        f.term_table = self.terms.capacity * @sizeOf([]const u8);
        f.dictionary_order = (self.sorted.capacity + self.overlay.capacity) * @sizeOf(TermId);

        // The hash map's backing layout is internal, so this is an estimate:
        // one key slice, one value and one metadata byte per slot.
        f.dictionary_hash = self.by_text.capacity() *
            (@sizeOf([]const u8) + @sizeOf(TermId) + 1);

        for (self.postings.items) |list| {
            f.postings_live += list.items.len * @sizeOf(Posting);
            f.postings_slack += (list.capacity - list.items.len) * @sizeOf(Posting);
        }
        f.postings_headers = self.postings.capacity * @sizeOf(std.ArrayList(Posting));

        f.block_table = self.blocks.capacity * @sizeOf(BlockInfo) +
            self.block_live.capacity * @sizeOf(bool) +
            self.block_terms.capacity * @sizeOf([]TermPost);

        for (self.block_terms.items) |bt| f.block_terms += bt.len * @sizeOf(TermPost);

        var it = self.backlinks.iterator();
        while (it.next()) |entry| {
            f.backlinks += entry.key_ptr.*.len +
                entry.value_ptr.capacity * @sizeOf(BlockRef);
        }
        f.backlinks += self.backlinks.capacity() *
            (@sizeOf([]const u8) + @sizeOf(std.ArrayList(BlockRef)) + 1);

        return f;
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
