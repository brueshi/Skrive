# Keystroke→paint gate harness (SKR-108, Stage 0)

The editor-surface rebuild has one non-negotiable acceptance criterion: **can I
type and the glyph is just there — imperceptible *and* constant-time, in any
document?** This harness measures that literal question and turns it into a
CI-checkable number, so every later stage has a bar to match or beat.

Plan: `planning/editor-surface-build-plan.md` ("The core gate").

## What it measures

The wall-clock from the `beforeinput` (or `paste`) that carries a keystroke to
the **paint** that shows its glyph. "Next paint" is timed with the established
approximation: a `requestAnimationFrame` (which runs just before render) posts a
`MessageChannel` message from inside the frame; that message task is delivered
*after* the frame is painted and composited, so its timestamp is a tight upper
bound on when the glyph became visible. The Event Timing API is recorded
alongside as a coarse (8 ms-quantised) standardized cross-check.

The real test is not the absolute p50 — it is **constant-time**: identical
latency in block 1 vs block 10,000, in a plain block vs an anchor-bearing one,
while the cold path churns. Anything that scales with the document has leaked
onto the hot path.

## Layout

- **Instrumentation core** — `app/src/lib/instrumentation/` (vehicle-agnostic,
  reused by every stage): `latency.ts` (the probe), `stats.ts` (percentiles +
  the constant-time verdict, unit-tested), `adversarial-doc.ts` (deterministic
  corpus generator), `LatencyOverlay.tsx` (live readout).
- **Harness page** — `app/harness.html` + `app/src/harness/main.tsx`. Mounts one
  editor surface over a synthetic corpus, isolated from the native bridge and the
  cold path — exactly the hot path the gate measures. Dev-served by Vite at
  `/harness.html?surface=rich&blocks=10000&anchors=50`.
- **Matrix runner** — `harness/playwright.config.ts` + `harness/latency.matrix.spec.ts`.
- **Baseline** — `harness/baseline.latency.json` (committed; the number to beat).

## Running

```sh
bun run test:latency      # boots Vite, drives the matrix, rewrites the baseline JSON
```

In the real app, type with the perf flag on to see live numbers in the shell's
own engine (the absolute truth):

```sh
VITE_SKRIVE_PERF=1 bun start
```

## Surrogate vs. truth

CI drives **Chromium**; the shipping shells are **WKWebView** (macOS) and
**WebView2** (Windows). Chromium is a *regression* surrogate — it reliably
catches the shape of a regression (a tail that grows with document size). The
*absolute* number is only true on the device, read from the in-app overlay. Do
not treat the CI millisecond as the shell millisecond.

## The Stage 0 finding

Today's editor is the baseline, not a pass. The matrix records the numbers; it
does not yet gate today's editor against itself. The headline result:

| Scenario | p50 | p99 | vs. block-1 |
|---|---|---|---|
| Rich, 200 blocks, block 1 | ~3 ms | ~10 ms | 1.0x |
| Rich, 10k blocks, last block | ~42 ms | ~280 ms | **~27x** |
| Anchor-bearing block | ~7 ms | ~69 ms | ~6.6x |
| Typing under cold-path load | ~7 ms | ~118 ms | ~12x |

Today's ProseMirror Rich surface renders the whole document (no virtualization),
so keystroke cost scales with document size — it **breaks constant-time at
scale**. That blowup is precisely the motivation for the block-canonical rebuild.
The `gate` tolerances in the baseline JSON are what later stages flip on (set
`GATE` assertions live in the spec) to prove the bespoke surface holds the line.
