// Keystroke→paint latency probe.
//
// The gate (planning/editor-surface-build-plan.md, "The core gate"): *can I type
// and the glyph is just there — imperceptible and constant-time?* This module
// measures the literal question: the wall-clock from the `beforeinput` that
// carries a keystroke to the paint that shows its glyph.
//
// How "next paint" is timed. There is no portable "paint happened" event, so we
// use the established approximation: schedule a `requestAnimationFrame` (which
// runs just before the browser renders the frame), and from inside it post a
// `MessageChannel` message. The message task is delivered *after* the frame has
// been painted and composited, so `performance.now()` there is a tight upper
// bound on when the glyph became visible. Marks are batched per frame so a burst
// of fast typing costs one rAF + one message per frame, not per keystroke.
//
// The Event Timing API (`PerformanceObserver`, type `event`) is recorded too, as
// a standardized cross-check. Its durations are quantised to 8ms, so it is the
// coarse second opinion; the rAF/MessageChannel sampler is the fine-grained
// primary metric the percentiles are computed from.
//
// Cost when off: nothing. The probe attaches only when explicitly enabled (the
// `VITE_SKRIVE_PERF` flag, or the harness forcing it on). No listener, no
// observer, no `window` surface in a normal session.

import { summarize, type LatencySummary } from './stats';

export type LatencyKind =
  | 'insert'
  | 'delete'
  | 'composition'
  | 'paste'
  | 'break'
  | 'other';

export type LatencySample = {
  /** `beforeinput` → post-paint, milliseconds. The gate's headline number. */
  dtMs: number;
  /** `performance.now()` at the originating `beforeinput`. */
  t0: number;
  kind: LatencyKind;
  /** The raw `InputEvent.inputType`, kept for after-the-fact slicing. */
  inputType: string;
};

export type LatencySnapshot = {
  /** Fine-grained beforeinput→paint summary — the primary metric. */
  summary: LatencySummary;
  /** Coarse (8ms-quantised) Event Timing durations, for cross-checking. */
  eventTiming: LatencySummary;
  sampleCount: number;
  /** Kinds the snapshot was filtered to, or null for all kinds. */
  kinds: LatencyKind[] | null;
};

export type LatencyProbeApi = {
  /** Drop all samples. The matrix calls this between scenarios. */
  reset(): void;
  /** Raw samples, newest last. */
  samples(): LatencySample[];
  /** Sample durations, optionally filtered to a set of kinds. */
  durations(kinds?: LatencyKind[]): number[];
  /** Summarised snapshot, optionally filtered to a set of kinds. */
  snapshot(kinds?: LatencyKind[]): LatencySnapshot;
  /** Detach listeners and the observer. */
  stop(): void;
};

declare global {
  interface Window {
    /** Exposed only while the probe is enabled — the Playwright matrix reads
     *  the gate's numbers from here. */
    __skriveLatency?: LatencyProbeApi;
  }
}

const RING_CAPACITY = 8192;

function classify(inputType: string): LatencyKind {
  if (inputType.includes('Composition')) return 'composition';
  if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop') return 'paste';
  if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') return 'break';
  if (inputType.startsWith('insert')) return 'insert';
  if (inputType.startsWith('delete')) return 'delete';
  return 'other';
}

type PendingMark = { t0: number; kind: LatencyKind; inputType: string };

let active: LatencyProbeApi | null = null;

/**
 * Attach the probe to a target (the document by default, so every editor
 * surface — Rich, Text, and the future bespoke surface — is covered with no
 * per-surface wiring). Idempotent: repeat calls return the live probe. The probe
 * is also published on `window.__skriveLatency`.
 */
export function enableLatencyProbe(
  target: Document | HTMLElement = document
): LatencyProbeApi {
  if (active) return active;

  const ring: LatencySample[] = [];
  function record(sample: LatencySample): void {
    ring.push(sample);
    if (ring.length > RING_CAPACITY) ring.shift();
  }

  // --- Event Timing cross-check (coarse, 8ms-quantised) -------------------
  const eventDurations: number[] = [];
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'beforeinput' || entry.name === 'input' || entry.name === 'keydown') {
            eventDurations.push(entry.duration);
            if (eventDurations.length > RING_CAPACITY) eventDurations.shift();
          }
        }
      });
      // `durationThreshold: 0` asks for every interaction, not just slow ones.
      observer.observe({ type: 'event', durationThreshold: 0, buffered: true } as PerformanceObserverInit);
    } catch {
      observer = null; // Event Timing unsupported — the primary sampler stands alone.
    }
  }

  // --- Primary sampler: beforeinput → post-paint --------------------------
  // Per-frame batching: the first mark of a frame schedules one rAF; that rAF
  // pushes the frame's batch and posts one message; the message handler stamps
  // the post-paint time once and resolves the whole batch. FIFO via a queue.
  const channel = new MessageChannel();
  const frameQueue: PendingMark[][] = [];
  let pending: PendingMark[] = [];
  let scheduled = false;

  channel.port1.onmessage = () => {
    const paintTime = performance.now();
    const batch = frameQueue.shift();
    if (!batch) return;
    for (const mark of batch) {
      record({ dtMs: paintTime - mark.t0, t0: mark.t0, kind: mark.kind, inputType: mark.inputType });
    }
  };

  function onFrame(): void {
    scheduled = false; // let a keystroke landing after this rAF schedule the next frame
    if (pending.length === 0) return;
    frameQueue.push(pending);
    pending = [];
    channel.port2.postMessage(0);
  }

  function pushMark(kind: LatencyKind, inputType: string): void {
    pending.push({ t0: performance.now(), kind, inputType });
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(onFrame);
    }
  }

  function onBeforeInput(event: Event): void {
    const inputType = (event as InputEvent).inputType ?? 'unknown';
    pushMark(classify(inputType), inputType);
  }

  // ProseMirror (and other rich editors) intercept paste via the `paste` event
  // and preventDefault it, so no `beforeinput` fires — without this the gate
  // would never see a paste land. Stamp the paste event directly; the next
  // post-paint resolves it like any other mark.
  function onPaste(): void {
    pushMark('paste', 'paste');
  }

  target.addEventListener('beforeinput', onBeforeInput, { capture: true });
  target.addEventListener('paste', onPaste, { capture: true });

  function durationsFor(kinds?: LatencyKind[]): number[] {
    const filtered = kinds && kinds.length > 0 ? ring.filter((s) => kinds.includes(s.kind)) : ring;
    return filtered.map((s) => s.dtMs);
  }

  const api: LatencyProbeApi = {
    reset() {
      ring.length = 0;
      eventDurations.length = 0;
      frameQueue.length = 0;
      pending = [];
    },
    samples() {
      return [...ring];
    },
    durations(kinds) {
      return durationsFor(kinds);
    },
    snapshot(kinds) {
      return {
        summary: summarize(durationsFor(kinds)),
        eventTiming: summarize(eventDurations),
        sampleCount: kinds && kinds.length > 0 ? durationsFor(kinds).length : ring.length,
        kinds: kinds && kinds.length > 0 ? [...kinds] : null
      };
    },
    stop() {
      target.removeEventListener('beforeinput', onBeforeInput, { capture: true });
      target.removeEventListener('paste', onPaste, { capture: true });
      observer?.disconnect();
      channel.port1.onmessage = null;
      if (active === api) active = null;
      if (typeof window !== 'undefined' && window.__skriveLatency === api) {
        delete window.__skriveLatency;
      }
    }
  };

  active = api;
  if (typeof window !== 'undefined') window.__skriveLatency = api;
  return api;
}

/** The live probe, or null if none is attached. */
export function getLatencyProbe(): LatencyProbeApi | null {
  return active;
}
