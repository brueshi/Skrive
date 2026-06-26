// Keystroke→paint gate instrumentation (SKR-108, Stage 0).
//
// The reusable, vehicle-agnostic core that every editor stage is measured by:
// the latency probe, the percentile statistics, the adversarial-document
// generator, and the live overlay. The Playwright matrix in harness/ drives the
// editor and reads these; nothing here depends on Playwright, React-DOM render,
// or the native bridge.
//
// Plan: planning/editor-surface-build-plan.md ("The core gate").

export {
  enableLatencyProbe,
  getLatencyProbe,
  type LatencyKind,
  type LatencySample,
  type LatencySnapshot,
  type LatencyProbeApi
} from './latency';
export {
  summarize,
  percentile,
  constantTimeRatio,
  EMPTY_SUMMARY,
  type LatencySummary
} from './stats';
export {
  buildAdversarialDoc,
  FIRST_BLOCK_MARKER,
  LAST_BLOCK_MARKER,
  ANCHORED_BLOCK_MARKER,
  type AdversarialDoc,
  type AdversarialDocOptions
} from './adversarial-doc';
export { LatencyOverlay } from './LatencyOverlay';
