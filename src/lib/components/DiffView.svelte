<script lang="ts">
  // Two-pane diff viewer. Parallel to `SplitView.svelte` — SplitView is
  // "same file, two representations"; DiffView is "same representation,
  // two versions." The two can't compose (see docs/3.3-diff-ui-design.md)
  // so diff mode is its own `LayoutMode` variant and diff entry is
  // disabled from `split`.
  //
  // Step 1.6 ships the scaffold: layout, pane headers, draggable
  // divider, content rendered as read-only text (raw mode) or rendered
  // markdown (preview mode), and the close / mode-flip chrome. The
  // line-level diff decorations land in Step 1.7 (raw) and Step 1.8
  // (preview); for now the two panes are plain side-by-side views.

  import { onMount } from "svelte";
  import IconX from "$lib/icons/IconX.svelte";
  import IconLayoutRaw from "$lib/icons/IconLayoutRaw.svelte";
  import IconLayoutPreview from "$lib/icons/IconLayoutPreview.svelte";
  import { project } from "$lib/stores/project.svelte";
  import { renderMarkdown } from "$lib/preview/markdown";
  import {
    segmentsForPreview,
    paneSegment,
    rowToSegmentIndex,
    type DiffSegment,
    type PaneSegment,
  } from "$lib/diff/preview-segments";
  import {
    measurePaneSegments,
    matchedScrollTop,
    linearScrollTop,
    currentChangeIndex,
    nextChangeTop,
    prevChangeTop,
    type SegMetric,
  } from "$lib/diff/sync-scroll";
  import type { DiffSide, LayoutMode } from "$lib/types";
  import type { LineDiffRow } from "$lib/diff/line-diff";

  type Props = {
    mode: "diff-raw" | "diff-preview";
    before: DiffSide;
    after: DiffSide;
    dividerRatio: number;
    rows: LineDiffRow[];
  };

  let { mode, before, after, dividerRatio, rows }: Props = $props();

  // Gutter glyphs per row kind, from the Phase 3.3 UI memo. Kept
  // rows get a quiet `·` so alignment is readable; add/delete rows
  // carry the louder markers.
  function gutterFor(kind: LineDiffRow["kind"], side: "before" | "after"): string {
    if (kind === "kept") return "·";
    if (kind === "added") return side === "after" ? "+" : "";
    // deleted
    return side === "before" ? "−" : "";
  }

  let container: HTMLDivElement;
  let dragging = $state(false);
  let dragBounds: { left: number; width: number } | null = null;

  // `now` ticks every minute so relative-time labels on the panes stay
  // fresh while diff mode is open, matching the history panel's
  // behavior. Cleaned up when this component unmounts.
  let now = $state(Date.now());
  $effect(() => {
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 60_000);
    return () => clearInterval(timer);
  });

  function relativeTime(tsMs: number, nowMs: number): string {
    const delta = nowMs - tsMs;
    if (delta < 0) return "just now";
    const seconds = Math.floor(delta / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks} wk${weeks === 1 ? "" : "s"} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} mo ago`;
    const years = Math.floor(days / 365);
    return `${years} yr${years === 1 ? "" : "s"} ago`;
  }

  function isoTooltip(side: DiffSide): string {
    return new Date(side.timestampMs).toISOString();
  }

  function handlePointerDown(e: PointerEvent) {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    dragBounds = { left: rect.left, width: rect.width };
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handlePointerMove(e: PointerEvent) {
    if (!dragging || !dragBounds) return;
    const offset = e.clientX - dragBounds.left;
    project.setDiffDividerRatio(offset / dragBounds.width);
  }

  function handlePointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    dragBounds = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  function switchMode(next: LayoutMode) {
    project.setLayoutMode(next);
  }

  function exitDiff() {
    project.exitDiffMode();
  }

  const leftFlex = $derived(dividerRatio);

  // Preview-mode segment machinery. Coalesces adjacent add/delete rows
  // so an edited paragraph reads as one block of revised prose rather
  // than a jagged sequence of per-line inserts and deletes. Rendering
  // is precomputed so the `{@html}` call in the template stays a
  // one-liner and the re-render cost is paid once per diff-entry,
  // not once per pane re-render.
  const segments = $derived(segmentsForPreview(rows));

  // The before pane can render kept/deleted content or a gap-added
  // placeholder; the after pane can render kept/added or a gap-deleted
  // placeholder. Narrowing the types per side lets the template's
  // {:else} branches typecheck against `{ html: string }` cleanly.
  type BeforeSegment =
    | { kind: "kept"; html: string }
    | { kind: "deleted"; html: string }
    | { kind: "gap-added" };

  type AfterSegment =
    | { kind: "kept"; html: string }
    | { kind: "added"; html: string }
    | { kind: "gap-deleted" };

  function renderBefore(segs: DiffSegment[]): BeforeSegment[] {
    return segs.map((seg) => {
      const pane = paneSegment(seg, "before");
      switch (pane.kind) {
        case "kept":
          return { kind: "kept", html: renderMarkdown(pane.source) };
        case "deleted":
          return { kind: "deleted", html: renderMarkdown(pane.source) };
        case "gap-added":
          return { kind: "gap-added" };
        default:
          throw new Error(
            `before pane cannot render ${(pane as PaneSegment).kind}`,
          );
      }
    });
  }

  function renderAfter(segs: DiffSegment[]): AfterSegment[] {
    return segs.map((seg) => {
      const pane = paneSegment(seg, "after");
      switch (pane.kind) {
        case "kept":
          return { kind: "kept", html: renderMarkdown(pane.source) };
        case "added":
          return { kind: "added", html: renderMarkdown(pane.source) };
        case "gap-deleted":
          return { kind: "gap-deleted" };
        default:
          throw new Error(
            `after pane cannot render ${(pane as PaneSegment).kind}`,
          );
      }
    });
  }

  const beforeSegments = $derived(renderBefore(segments));
  const afterSegments = $derived(renderAfter(segments));

  // Row-to-segment map for raw mode; used to tag the first row of
  // each segment with `data-diff-seg-index` so the scroll-sync and
  // navigation code can reuse the same mechanism in both modes.
  const rowSegMap = $derived(rowToSegmentIndex(rows));

  // Segment indices that correspond to change (add/delete) regions —
  // what `n` / `p` navigate between and what the "N of M" counter
  // uses for the denominator.
  const changeSegIndices = $derived(
    segments
      .map((s, i) => (s.kind === "change" ? i : -1))
      .filter((i) => i >= 0),
  );

  // ================== Scroll-sync state ==================
  //
  // Two modes per the UI memo:
  //   - "matched" (default): segment-aligned sync. Useful in preview
  //     mode where paired blocks can have different rendered heights.
  //   - "linear": scroll-height ratio. Simpler; what the user wants
  //     when the diff is small enough that segment alignment feels
  //     over-engineered.
  //
  // Raw mode's rows are pre-aligned across panes (placeholders
  // equalize row counts), so linear and matched collapse to the same
  // behavior there. The toggle still renders, just for consistency.
  let scrollMode = $state<"matched" | "linear">("matched");
  let beforePaneBody = $state<HTMLElement | undefined>();
  let afterPaneBody = $state<HTMLElement | undefined>();
  let beforeSegMetrics = $state<SegMetric[]>([]);
  let afterSegMetrics = $state<SegMetric[]>([]);
  let currentChange = $state(-1);

  // Feedback-loop guard. Setting `scrollTop` on a pane programmatically
  // fires another `scroll` event; we flip this flag before the sync
  // write and clear it on the next frame so the echo is ignored.
  let programmaticScroll = false;
  let pendingRaf: number | null = null;

  function scheduleSyncFrom(side: "before" | "after") {
    if (programmaticScroll) return;
    if (pendingRaf !== null) return;
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = null;
      syncFrom(side);
    });
  }

  function syncFrom(side: "before" | "after") {
    const from = side === "before" ? beforePaneBody : afterPaneBody;
    const to = side === "before" ? afterPaneBody : beforePaneBody;
    if (!from || !to) return;

    const target = computeTargetScrollTop(side);
    // Update the counter from whichever pane the user is driving —
    // usually the before pane, but a mouse on the after side works too.
    currentChange = currentChangeIndex(
      from.scrollTop,
      side === "before" ? beforeSegMetrics : afterSegMetrics,
      changeSegIndices,
    );

    if (Math.abs(to.scrollTop - target) < 0.5) return;
    programmaticScroll = true;
    to.scrollTop = target;
    requestAnimationFrame(() => {
      programmaticScroll = false;
    });
  }

  function computeTargetScrollTop(side: "before" | "after"): number {
    const from = side === "before" ? beforePaneBody : afterPaneBody;
    const to = side === "before" ? afterPaneBody : beforePaneBody;
    if (!from || !to) return 0;
    const fromMetrics = side === "before" ? beforeSegMetrics : afterSegMetrics;
    const toMetrics = side === "before" ? afterSegMetrics : beforeSegMetrics;

    // Raw mode rows are pre-aligned across panes, so the same scroll
    // position lines them up exactly. Matching via segments would
    // still work but carries a tiny rounding cost; direct match is
    // both cheaper and more precise.
    if (mode === "diff-raw") {
      return Math.min(from.scrollTop, to.scrollHeight);
    }

    if (scrollMode === "matched") {
      return matchedScrollTop(
        from.scrollTop,
        fromMetrics,
        toMetrics,
        from.scrollHeight,
        to.scrollHeight,
      );
    }
    return linearScrollTop(from.scrollTop, from.scrollHeight, to.scrollHeight);
  }

  function remeasure() {
    if (beforePaneBody) beforeSegMetrics = measurePaneSegments(beforePaneBody);
    if (afterPaneBody) afterSegMetrics = measurePaneSegments(afterPaneBody);
  }

  // Remeasure after every paint that could change layout: the pane
  // refs getting set, the mode flipping, the rows list updating, and
  // the divider dragging. `requestAnimationFrame` inside the effect
  // waits for the next frame so measurements read post-layout values.
  $effect(() => {
    // Touch dependencies so Svelte re-runs the effect on change.
    void beforePaneBody;
    void afterPaneBody;
    void mode;
    void rows;
    void dividerRatio;
    const raf = requestAnimationFrame(remeasure);
    return () => cancelAnimationFrame(raf);
  });

  // Window resize re-measures too. `ResizeObserver` on the two pane
  // bodies is more targeted than a window listener, but window is
  // simpler and fires on the cases that matter (window resize,
  // devtools toggle).
  $effect(() => {
    const handler = () => remeasure();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  });

  // ================== Change navigation ==================

  function scrollTo(y: number) {
    if (!beforePaneBody) return;
    programmaticScroll = true;
    beforePaneBody.scrollTop = y;
    // Drive the after pane too so both move in lockstep.
    const target = computeTargetScrollTopFor(y, "before");
    if (afterPaneBody) afterPaneBody.scrollTop = target;
    requestAnimationFrame(() => {
      programmaticScroll = false;
      // Refresh the counter from the new position.
      currentChange = currentChangeIndex(
        y,
        beforeSegMetrics,
        changeSegIndices,
      );
    });
  }

  function computeTargetScrollTopFor(
    fromTop: number,
    fromSide: "before" | "after",
  ): number {
    const fromBody = fromSide === "before" ? beforePaneBody : afterPaneBody;
    const toBody = fromSide === "before" ? afterPaneBody : beforePaneBody;
    if (!fromBody || !toBody) return 0;
    if (mode === "diff-raw") return Math.min(fromTop, toBody.scrollHeight);
    const fromMetrics = fromSide === "before" ? beforeSegMetrics : afterSegMetrics;
    const toMetrics = fromSide === "before" ? afterSegMetrics : beforeSegMetrics;
    if (scrollMode === "matched") {
      return matchedScrollTop(
        fromTop,
        fromMetrics,
        toMetrics,
        fromBody.scrollHeight,
        toBody.scrollHeight,
      );
    }
    return linearScrollTop(fromTop, fromBody.scrollHeight, toBody.scrollHeight);
  }

  function gotoNextChange() {
    if (!beforePaneBody) return;
    const target = nextChangeTop(
      beforePaneBody.scrollTop,
      beforeSegMetrics,
      changeSegIndices,
    );
    if (target !== null) scrollTo(target);
  }

  function gotoPrevChange() {
    if (!beforePaneBody) return;
    const target = prevChangeTop(
      beforePaneBody.scrollTop,
      beforeSegMetrics,
      changeSegIndices,
    );
    if (target !== null) scrollTo(target);
  }

  function gotoFirstChange() {
    if (changeSegIndices.length === 0) return;
    const first = beforeSegMetrics.find(
      (m) => m.index === changeSegIndices[0],
    );
    if (first) scrollTo(first.top);
  }

  function gotoLastChange() {
    if (changeSegIndices.length === 0) return;
    const last = beforeSegMetrics.find(
      (m) => m.index === changeSegIndices[changeSegIndices.length - 1],
    );
    if (last) scrollTo(last.top);
  }

  // Diff view is read-only, so we don't have to worry about interfering
  // with typing. Keybindings are window-scoped and only live while the
  // component is mounted — which is only when the tab is in diff mode.
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      // Leave modified-key combos to the page-level handler (⌘⇧H, etc.)
      // and to browser shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      if (key === "n" || key === "j") {
        e.preventDefault();
        gotoNextChange();
      } else if (key === "p" || key === "k") {
        e.preventDefault();
        gotoPrevChange();
      } else if (key === "Home") {
        e.preventDefault();
        gotoFirstChange();
      } else if (key === "End") {
        e.preventDefault();
        gotoLastChange();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  // UI-facing counter values: "current of total". When the user is
  // above all changes, current is -1 internally; the template renders
  // that as 0, so the reading "0 of 12" means "before the first
  // change." Once they scroll into the first change the counter
  // advances to "1 of 12".
  const changeCount = $derived(changeSegIndices.length);
  const currentChangeDisplay = $derived(
    currentChange < 0 ? 0 : currentChange + 1,
  );
</script>

<div
  class="diff-view"
  class:dragging
  bind:this={container}
  style:--diff-left-ratio={leftFlex}
>
  <header class="diff-chrome">
    <div class="diff-chrome-slot diff-chrome-slot-before">
      <span class="diff-pane-label">
        <span class="diff-pane-label-kind">Before</span>
        <span class="diff-pane-label-name" title={isoTooltip(before)}
          >{before.label}</span
        >
        <span class="diff-pane-label-time">— {relativeTime(before.timestampMs, now)}</span>
      </span>
    </div>
    <div class="diff-chrome-divider" aria-hidden="true"></div>
    <div class="diff-chrome-slot diff-chrome-slot-after">
      <span class="diff-pane-label">
        <span class="diff-pane-label-kind">After</span>
        <span class="diff-pane-label-name" title={isoTooltip(after)}
          >{after.label}</span
        >
        <span class="diff-pane-label-time">— {relativeTime(after.timestampMs, now)}</span>
      </span>
      <div class="diff-actions">
        {#if changeCount > 0}
          <span
            class="diff-change-counter"
            title="Current change of total  ·  n/p to navigate"
            >{currentChangeDisplay} of {changeCount}</span
          >
        {/if}
        <div
          class="diff-scroll-toggle"
          role="group"
          aria-label="Scroll sync mode"
          title="Scroll sync: matched keeps paired blocks aligned; linear maps scroll position by pane height"
        >
          <button
            type="button"
            class="diff-scroll-button"
            class:active={scrollMode === "matched"}
            aria-pressed={scrollMode === "matched"}
            onclick={() => (scrollMode = "matched")}>matched</button
          >
          <button
            type="button"
            class="diff-scroll-button"
            class:active={scrollMode === "linear"}
            aria-pressed={scrollMode === "linear"}
            onclick={() => (scrollMode = "linear")}>linear</button
          >
        </div>
        <div class="diff-mode-toggle" role="group" aria-label="Diff representation">
          <button
            type="button"
            class="diff-mode-button"
            class:active={mode === "diff-raw"}
            aria-pressed={mode === "diff-raw"}
            title="Diff raw source"
            onclick={() => switchMode("raw")}
          >
            <IconLayoutRaw size={16} />
          </button>
          <button
            type="button"
            class="diff-mode-button"
            class:active={mode === "diff-preview"}
            aria-pressed={mode === "diff-preview"}
            title="Diff rendered preview"
            onclick={() => switchMode("preview")}
          >
            <IconLayoutPreview size={16} />
          </button>
        </div>
        <button
          type="button"
          class="diff-close"
          aria-label="Exit diff mode"
          title="Exit diff  Esc"
          onclick={exitDiff}
        >
          <IconX size={16} />
        </button>
      </div>
    </div>
  </header>

  <div class="diff-panes">
    <div class="diff-pane diff-pane-before">
      {#if mode === "diff-preview"}
        <div
          class="diff-pane-body diff-pane-preview"
          bind:this={beforePaneBody}
          onscroll={() => scheduleSyncFrom("before")}
        >
          {#each beforeSegments as seg, i (i)}
            {#if seg.kind === "gap-added"}
              <div
                class="diff-preview-seg diff-preview-gap-added"
                data-diff-seg-index={i}
              >
                <span class="diff-preview-chip">added</span>
              </div>
            {:else}
              <div
                class="diff-preview-seg diff-preview-{seg.kind}"
                data-diff-seg-index={i}
              >
                {@html seg.html}
              </div>
            {/if}
          {/each}
        </div>
      {:else}
        <div
          class="diff-pane-body diff-pane-raw"
          bind:this={beforePaneBody}
          onscroll={() => scheduleSyncFrom("before")}
        >
          <div class="diff-rows">
            {#each rows as row, i (i)}
              {@const segIdx = rowSegMap[i]}
              {@const isSegStart = i === 0 || rowSegMap[i - 1] !== segIdx}
              <div
                class="diff-row diff-row-{row.kind}"
                data-diff-seg-index={isSegStart ? segIdx : undefined}
              >
                <span class="diff-gutter">{gutterFor(row.kind, "before")}</span>
              {#if row.before !== null}
                <span class="diff-text">{row.before || " "}</span>
              {:else}
                <span class="diff-text diff-text-placeholder" aria-hidden="true"></span>
              {/if}
            </div>
          {/each}
          </div>
        </div>
      {/if}
    </div>

    <div
      class="diff-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize before and after"
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerUp}
    ></div>

    <div class="diff-pane diff-pane-after">
      {#if mode === "diff-preview"}
        <div
          class="diff-pane-body diff-pane-preview"
          bind:this={afterPaneBody}
          onscroll={() => scheduleSyncFrom("after")}
        >
          {#each afterSegments as seg, i (i)}
            {#if seg.kind === "gap-deleted"}
              <div
                class="diff-preview-seg diff-preview-gap-deleted"
                data-diff-seg-index={i}
              >
                <span class="diff-preview-chip">deleted</span>
              </div>
            {:else}
              <div
                class="diff-preview-seg diff-preview-{seg.kind}"
                data-diff-seg-index={i}
              >
                {@html seg.html}
              </div>
            {/if}
          {/each}
        </div>
      {:else}
        <div
          class="diff-pane-body diff-pane-raw"
          bind:this={afterPaneBody}
          onscroll={() => scheduleSyncFrom("after")}
        >
          <div class="diff-rows">
            {#each rows as row, i (i)}
              {@const segIdx = rowSegMap[i]}
              {@const isSegStart = i === 0 || rowSegMap[i - 1] !== segIdx}
              <div
                class="diff-row diff-row-{row.kind}"
                data-diff-seg-index={isSegStart ? segIdx : undefined}
              >
                <span class="diff-gutter">{gutterFor(row.kind, "after")}</span>
              {#if row.after !== null}
                <span class="diff-text">{row.after || " "}</span>
              {:else}
                <span class="diff-text diff-text-placeholder" aria-hidden="true"></span>
              {/if}
            </div>
          {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .diff-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .diff-chrome {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--skrive-rule);
    background: var(--skrive-bg);
    flex-shrink: 0;
    min-height: 36px;
    box-sizing: border-box;
  }

  /* Each chrome slot mirrors its pane's horizontal extent by solving
     the same `calc()` off a shared `--diff-left-ratio` custom
     property. Doing this with `flex: X 1 0` — the natural way —
     produced a sub-pixel drift on resize because the flex algorithm
     rounds the proportional split slightly differently in the chrome
     and pane rows. A `calc()`-based fixed flex-basis is exact.
     Before side = ratio × (container - divider); after fills what's
     left; divider is 1px. Chrome and panes use identical formulas
     off the same custom property, so their dividers land on the
     same physical column at every drag position. */
  .diff-chrome-slot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    min-width: 0;
    box-sizing: border-box;
  }

  .diff-chrome-slot-before {
    flex: 0 0 calc((100% - 1px) * var(--diff-left-ratio));
  }

  .diff-chrome-slot-after {
    flex: 1 1 0;
    /* Label left-aligned at the start of the slot (so it hugs the
       divider); actions pushed to the right edge of the slot. */
    justify-content: space-between;
    min-width: 0;
  }

  /* 1px chrome divider between the slots — same structure as the
     pane row below. */
  .diff-chrome-divider {
    flex: 0 0 1px;
    background: var(--skrive-rule);
  }

  .diff-pane-label {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 12px;
    color: var(--skrive-fg);
    min-width: 0;
    overflow: hidden;
  }

  .diff-pane-label-kind {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--skrive-muted);
    flex-shrink: 0;
  }

  .diff-pane-label-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .diff-pane-label-time {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    flex-shrink: 0;
  }

  .diff-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  /* "3 of 12" — current/total change counter. Hidden when the diff
     has no changes (identical before/after). */
  .diff-change-counter {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--skrive-muted);
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  /* Small two-state pill for scroll-sync mode. Same visual language
     as the raw/preview toggle but text-only so it reads as a mode
     name rather than an action. */
  .diff-scroll-toggle {
    display: inline-flex;
    border: 1px solid var(--skrive-rule);
    border-radius: 4px;
    overflow: hidden;
  }

  .diff-scroll-button {
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    cursor: pointer;
    height: 24px;
    padding: 0 0.5rem;
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: lowercase;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .diff-scroll-button + .diff-scroll-button {
    border-left: 1px solid var(--skrive-rule);
  }

  .diff-scroll-button:hover {
    color: var(--skrive-fg);
  }

  .diff-scroll-button.active {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  .diff-mode-toggle {
    display: inline-flex;
    border: 1px solid var(--skrive-rule);
    border-radius: 4px;
    overflow: hidden;
  }

  .diff-mode-button {
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    cursor: pointer;
    width: 28px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .diff-mode-button + .diff-mode-button {
    border-left: 1px solid var(--skrive-rule);
  }

  .diff-mode-button:hover {
    color: var(--skrive-fg);
  }

  .diff-mode-button.active {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  .diff-close {
    background: transparent;
    border: none;
    color: var(--skrive-muted);
    cursor: pointer;
    width: 26px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    padding: 0;
    transition:
      color 0.12s cubic-bezier(0.4, 0, 0.2, 1),
      background-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .diff-close:hover {
    color: var(--skrive-fg);
    background: var(--skrive-rule);
  }

  .diff-panes {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .diff-pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--skrive-bg);
  }

  /* Same formula as the chrome's before slot so the two dividers
     share a pixel-exact split point. See `.diff-chrome-slot-before`
     for the rationale. */
  .diff-pane-before {
    flex: 0 0 calc((100% - 1px) * var(--diff-left-ratio));
  }

  .diff-pane-after {
    flex: 1 1 0;
  }

  .diff-pane-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  /* Row container for the raw diff. Every row is the same height so
     the two panes stay aligned index-for-index — no wrapping, no
     variable-height placeholders. Long lines scroll horizontally.
     Sync scroll lands in Step 1.9; for now each pane scrolls
     independently. */
  .diff-pane-raw {
    padding: 0.5rem 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.55;
    color: var(--skrive-fg);
    background: var(--skrive-bg);
    tab-size: 2;
  }

  /* Inline-block wrapper so the container's width is
     `max(100%, widest-row-content)`. Rows inside are block-level and
     inherit that width, which lets tinted backgrounds extend to the
     end of the widest row on every row — otherwise a short added
     line's sage tint would stop mid-pane while a long line's would
     push out past the scrollbar. */
  .diff-rows {
    display: inline-block;
    min-width: 100%;
  }

  .diff-row {
    display: flex;
    align-items: baseline;
    min-height: 1.55em;
    border-left: 2px solid transparent;
    padding-right: 1rem;
  }

  .diff-gutter {
    flex: 0 0 1.5rem;
    text-align: center;
    color: var(--skrive-muted);
    user-select: none;
    font-size: 11px;
    align-self: center;
  }

  /* Size to content so long lines push the containing `.diff-rows`
     wider than the pane — the pane's own `overflow: auto` catches
     that and shows a horizontal scrollbar. Short lines stay short;
     the row's background tint still fills across because the row
     width comes from the container, not from this element. */
  .diff-text {
    white-space: pre;
  }

  /* Placeholders still need to stretch so the dashed underline fills
     the row's empty slot visually. `flex: 1` pulls the empty span to
     the row's right edge. */
  .diff-text-placeholder {
    flex: 1;
    min-width: 0;
    min-height: 1.55em;
  }

  /* Palette from docs/3.3-diff-ui-design.md §Visual language.
     Added: sage tint background + fuller-saturation left bar, both
     warm-leaning so they sit in the cream family rather than reading
     as git-diff green. Deleted: no fill, strikethrough + 55% opacity
     + a thin warm-gray bar — the "something was here" signal without
     competing with the added content for attention. */
  .diff-row-added {
    background: hsl(95, 20%, 92%);
    border-left-color: hsl(100, 15%, 45%);
  }

  .diff-row-deleted {
    border-left-color: hsl(30, 8%, 60%);
  }

  .diff-row-deleted .diff-text {
    text-decoration: line-through;
    opacity: 0.55;
  }

  /* Placeholder rows (the opposite pane's gap next to an add/delete).
     Render a faint dashed edge so the eye registers the gap without
     mistaking it for whitespace-heavy prose. */
  .diff-row-added .diff-text-placeholder,
  .diff-row-deleted .diff-text-placeholder {
    border-bottom: 1px dashed var(--skrive-rule);
    align-self: stretch;
    margin: 0.5em 0.25rem;
  }

  @media (prefers-color-scheme: dark) {
    .diff-row-added {
      background: hsl(95, 15%, 20%);
      border-left-color: hsl(100, 22%, 65%);
    }
    .diff-row-deleted {
      border-left-color: hsl(30, 5%, 45%);
    }
  }

  .diff-pane-preview {
    padding: 1.25rem 1.5rem 3rem;
    font-family:
      "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia,
      serif;
    font-size: 1rem;
    line-height: 1.65;
    color: var(--skrive-fg);
  }

  /* Per-segment wrapper in preview mode. Kept segments carry no
     decoration — they read as the document. Added / deleted segments
     get the same palette as raw mode's rows but applied to the
     rendered HTML block: sage tint + left bar for adds, strike +
     opacity + warm-gray bar for deletes. Placeholder gaps use a
     dashed rule with a small chip so the reader's eye registers the
     opposite-pane change without leaving a visible hole. */
  .diff-preview-seg {
    border-left: 2px solid transparent;
    padding: 0.05rem 0.75rem 0.05rem 1rem;
    margin: 0 -0.5rem 0.25rem;
    border-radius: 2px;
  }

  /* `.diff-preview-kept` gets no visual decoration — the chrome
     around the pane already signals "you're in a diff", and kept
     segments should read as prose. */

  .diff-preview-added {
    background: hsl(95, 20%, 92%);
    border-left-color: hsl(100, 15%, 45%);
  }

  .diff-preview-deleted {
    border-left-color: hsl(30, 8%, 60%);
    opacity: 0.7;
  }

  .diff-preview-deleted :global(p),
  .diff-preview-deleted :global(li),
  .diff-preview-deleted :global(h1),
  .diff-preview-deleted :global(h2),
  .diff-preview-deleted :global(h3),
  .diff-preview-deleted :global(h4),
  .diff-preview-deleted :global(h5),
  .diff-preview-deleted :global(h6),
  .diff-preview-deleted :global(blockquote) {
    text-decoration: line-through;
    text-decoration-thickness: 1px;
  }

  .diff-preview-gap-added,
  .diff-preview-gap-deleted {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5em;
    border: 1px dashed hsl(95, 20%, 80%);
    border-radius: 3px;
    margin: 0.5em -0.5rem;
  }

  .diff-preview-gap-deleted {
    border-color: hsl(30, 12%, 75%);
  }

  .diff-preview-chip {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--skrive-muted);
    padding: 0.1em 0.45em;
    border: 1px solid var(--skrive-rule);
    border-radius: 3px;
    background: var(--skrive-bg);
  }

  @media (prefers-color-scheme: dark) {
    .diff-preview-added {
      background: hsl(95, 15%, 20%);
      border-left-color: hsl(100, 22%, 65%);
    }
    .diff-preview-deleted {
      border-left-color: hsl(30, 5%, 45%);
    }
    .diff-preview-gap-added {
      border-color: hsl(95, 15%, 30%);
    }
    .diff-preview-gap-deleted {
      border-color: hsl(30, 5%, 35%);
    }
  }

  /* Markdown typography inside preview-mode segments. Mirrors
     Preview.svelte's rules so rendered prose reads the same in full-
     file preview and in diff-preview. Scoped to .diff-pane-preview
     so the raw pane isn't affected. */
  .diff-pane-preview :global(h1),
  .diff-pane-preview :global(h2),
  .diff-pane-preview :global(h3),
  .diff-pane-preview :global(h4),
  .diff-pane-preview :global(h5),
  .diff-pane-preview :global(h6) {
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.25;
    margin: 1.25em 0 0.4em;
    color: var(--skrive-fg);
  }

  .diff-pane-preview :global(h1) {
    font-size: 1.6rem;
    margin-top: 0;
  }
  .diff-pane-preview :global(h2) {
    font-size: 1.3rem;
  }
  .diff-pane-preview :global(h3) {
    font-size: 1.1rem;
  }
  .diff-pane-preview :global(h4),
  .diff-pane-preview :global(h5),
  .diff-pane-preview :global(h6) {
    font-size: 1rem;
  }

  .diff-pane-preview :global(p) {
    margin: 0 0 0.85em;
  }

  .diff-pane-preview :global(a) {
    color: var(--skrive-link);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }

  .diff-pane-preview :global(strong) {
    font-weight: 600;
  }

  .diff-pane-preview :global(em) {
    font-style: italic;
  }

  .diff-pane-preview :global(ul),
  .diff-pane-preview :global(ol) {
    margin: 0 0 0.85em;
    padding-left: 1.5em;
  }

  .diff-pane-preview :global(li) {
    margin-bottom: 0.2em;
  }

  .diff-pane-preview :global(blockquote) {
    margin: 0.85em 0;
    padding: 0.25em 0 0.25em 1em;
    border-left: 2px solid var(--skrive-rule);
    color: var(--skrive-muted);
  }

  .diff-pane-preview :global(hr) {
    border: 0;
    border-top: 1px solid var(--skrive-rule);
    margin: 1.5em 0;
  }

  .diff-pane-preview :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: var(--skrive-rule);
    padding: 0.1em 0.35em;
    border-radius: 3px;
  }

  .diff-pane-preview :global(pre) {
    background: var(--skrive-rule);
    padding: 0.85em;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0.85em 0;
    line-height: 1.5;
  }

  .diff-pane-preview :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: 0.85rem;
  }

  .diff-pane-preview :global(img) {
    max-width: 100%;
    height: auto;
  }

  .diff-pane-preview :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.85em 0;
    font-size: 0.95em;
  }

  .diff-pane-preview :global(th),
  .diff-pane-preview :global(td) {
    border-bottom: 1px solid var(--skrive-rule);
    padding: 0.5em 0.75em;
    text-align: left;
  }

  .diff-pane-preview :global(th) {
    font-weight: 600;
  }

  .diff-divider {
    flex: 0 0 1px;
    width: 1px;
    cursor: col-resize;
    background: var(--skrive-rule);
    position: relative;
    touch-action: none;
  }

  .diff-divider::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -4px;
    right: -4px;
  }

  .diff-divider:hover,
  .diff-view.dragging .diff-divider {
    background: var(--skrive-fg);
  }

  .diff-view.dragging {
    user-select: none;
  }
</style>
