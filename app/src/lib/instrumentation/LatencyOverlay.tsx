// Live keystroke→paint readout. A small fixed badge in the corner that shows
// the gate's numbers as you type — the same metric the Playwright matrix asserts
// on, but in the real shell (WKWebView / WebView2), which is the only place the
// *absolute* number is the truth. CI's Chromium is a regression surrogate; this
// is ground truth.
//
// Mounted only when the perf flag is on, so it costs nothing in a normal session.
// It samples on an interval (not per keystroke) to stay off the hot path it is
// measuring.

import { useEffect, useState } from 'react';
import { getLatencyProbe, type LatencySnapshot } from './latency';

const REFRESH_MS = 250;

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(1);
}

export function LatencyOverlay() {
  const [snap, setSnap] = useState<LatencySnapshot | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSnap(getLatencyProbe()?.snapshot() ?? null);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const s = snap?.summary;
  const hot = (s?.p99 ?? 0) > 16; // a frame budget; red past one dropped frame

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 8,
        right: 8,
        zIndex: 2147483647,
        font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: hot ? '#fca5a5' : '#9ca3af',
        background: 'rgba(17,17,19,0.82)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6,
        padding: '6px 8px',
        pointerEvents: 'none',
        whiteSpace: 'pre',
        letterSpacing: '0.01em'
      }}
      aria-hidden
    >
      {`keystroke→paint  n=${s?.count ?? 0}\n` +
        `p50 ${fmt(s?.p50 ?? NaN)}  p99 ${fmt(s?.p99 ?? NaN)}  max ${fmt(s?.max ?? NaN)} ms`}
    </div>
  );
}
