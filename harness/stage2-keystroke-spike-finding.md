# Stage 2 keystroke spike — finding (SKR-109)

**Status.** 2026-06-26. **Outcome: PASS.** A framework-free `contenteditable`
clears the latency gate constant-time and holds IME and paste. Stage 3 builds the
real bespoke surface — no ProseMirror fallback. Supersedes nothing; this is the
empirical answer the build plan front-loaded as the existential risk.

## The question

The gate (planning/editor-surface-build-plan.md): *can I type and the glyph is
just there — imperceptible and constant-time, in any document?* Stage 0 measured
today's editor — a single ProseMirror `contenteditable` — at **27x** non-constant
(p99 ~10ms at block 1 vs ~280ms at block 10,000). The spike's job: find out
whether that blowup is **the browser's `contenteditable` scaling** or
**ProseMirror's JS overhead on top**, by stripping the framework and measuring two
DOM structures with one shared, React-free hot path (intercept `beforeinput`,
mutate the focused block's text node imperatively, move the caret).

- **single** — one `contenteditable` host, every block a child element.
- **perblock** — one `contenteditable` host per block (others inert): block-local
  by construction, but caret/selection across a block boundary is not native.

Throwaway code: `app/src/harness/bespoke/` + `harness/bespoke.matrix.spec.ts`,
driven by the Stage 0 harness over the same adversarial corpus. Numbers in
`harness/bespoke.latency.json`.

## The numbers (Chromium surrogate)

p99 keystroke→paint, milliseconds:

| Scenario | single | perblock | today (PM) |
|---|---|---|---|
| block 1 of 200 | 15.2 | 9.4 | ~10 |
| **last block of 10k** | **13.8** | **11.9** | **~280** |
| **constant-time ratio** | **0.91x** | **1.26x** | **27x** |
| anchor-bearing block | 9.6 | 9.8 | ~69 |
| typing under cold-path load | 13.2 | 9.1 | ~118 |
| paste (one large insert) | 3.6 | 4.4 | ~8 |
| IME composition | 13.9 (landed) | 8.4 (landed) | — |

Held-key autorepeat reads high on both (~70–82ms) — that is the frame-saturation
artifact (many synthetic keystrokes share one paint at `delay:0`), and it is
*lower* than today's PM (~140ms), not a per-keystroke regression.

## What it means

1. **The browser is constant-time; ProseMirror was the cost.** A raw single
   `contenteditable` lands a glyph in ~14ms whether the caret is in block 1 or
   block 10,000 (**0.91x**). The 27x was the framework, not the platform. This is
   the load-bearing result: bespoke is viable, and it can be *simple*.
2. **Single-CE wins outright.** Both structures are constant-time, but
   **single-CE keeps native cross-block selection and caret movement** while
   per-block does not — and per-block's isolation buys no latency advantage here.
   So the per-block complexity (a custom cross-block selection/caret model) is
   unnecessary. Build Stage 3 on a single `contenteditable`.
3. **IME and paste hold.** Native composition lands its text on both structures at
   gate-clearing latency; paste handled imperatively is a single fast block-local
   insert.

## Seams Stage 3 must own (not in this spike)

The spike measured latency only; it does not keep a model in sync, and it handles
only `insertText` + paste imperatively (deletes, breaks, and composition fall
through to the browser). Stage 3's real surface must:

- Keep the block model authoritative on every edit (the spike mutated DOM only).
- Handle Enter (block split), Backspace at a block boundary (merge), and deletes —
  the operations that move content *between* blocks, where the single-CE browser
  default must be intercepted and routed through block commands + the id-survival
  contract (split mints, merge keeps survivor).
- Drive composition (IME) through the model without breaking the native compose,
  and keep the imperative DOM patch in lockstep with the model.
- Confirm the number on the **real shell engine** (WKWebView / WebView2) via the
  in-app overlay — Chromium is a regression surrogate, not the on-device truth.

## Fork decision

**PASS → Stage 3 (SKR-95) builds the bespoke surface on a single
`contenteditable`, framework-free hot path.** The ProseMirror fallback rung is not
needed and is not taken. The Stage 1 core (block model, Markdown contract, shared
markdown-core) plugs straight in underneath.
