// Keystroke→paint adversarial matrix (SKR-108, Stage 0).
//
// Runs the gate's matrix against today's editor and writes the baseline every
// later stage must match or beat (harness/baseline.latency.json). The headline
// question is constant-time: does a glyph land in the same milliseconds in block
// 1 vs block 10,000, in a plain block vs an anchor-bearing one, while the cold
// path churns? (planning/editor-surface-build-plan.md, "The core gate".)
//
// What this asserts now vs. later. Against today's editor — which *is* the
// baseline — the only hard assertions are that the measurement is live: every
// scenario captures samples with a finite p99. The constant-time ratios are
// recorded, not gated: today's non-virtualised Rich surface rendering 10k nodes
// is expected to break constant-time, and that finding is exactly the motivation
// for the rebuild. Later stages flip GATE on to assert the ratios against this
// file.

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { constantTimeRatio, type LatencySummary } from '../app/src/lib/instrumentation/stats';

const BASELINE_PATH = fileURLToPath(new URL('baseline.latency.json', import.meta.url));

// Tolerances later stages assert against (a candidate tail may be at most this
// multiple of the baseline tail). Recorded-only here; see header.
const GATE = {
  positionTolerance: 1.6, // block 10k vs block 1
  coldTolerance: 1.8, // typing under cold-path contention vs idle
  anchorTolerance: 1.4 // anchor-bearing block vs plain block
};

type Snapshot = {
  summary: LatencySummary;
  eventTiming: LatencySummary;
  sampleCount: number;
  kinds: string[] | null;
};

type ScenarioRecord = {
  params: Record<string, string | number>;
  summary: LatencySummary;
  eventTiming: LatencySummary;
  sampleCount: number;
};

const results: Record<string, ScenarioRecord> = {};
const ratios: Record<string, { ratio: number; withinTolerance: boolean; tolerance: number }> = {};

const PARAGRAPH = 'the quick brown fox jumps over the lazy dog and keeps on writing ';

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}

function roundSummary(s: LatencySummary): LatencySummary {
  return {
    count: s.count,
    min: round2(s.min),
    mean: round2(s.mean),
    p50: round2(s.p50),
    p90: round2(s.p90),
    p99: round2(s.p99),
    max: round2(s.max)
  };
}

async function openHarness(
  page: Page,
  params: { surface: 'rich' | 'text'; blocks: number; anchors?: number }
): Promise<void> {
  const anchors = params.anchors ?? 0;
  await page.goto(`/harness.html?surface=${params.surface}&blocks=${params.blocks}&anchors=${anchors}`);
  await page.waitForFunction(
    () => (window as unknown as { __skriveHarness?: { ready?: boolean } }).__skriveHarness?.ready === true,
    undefined,
    { timeout: 90_000 }
  );
}

async function caretAt(page: Page, marker: string): Promise<void> {
  const loc = page.getByText(marker, { exact: false }).first();
  await loc.scrollIntoViewIfNeeded();
  await loc.click();
  await page.keyboard.press('End');
}

async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __skriveLatency?: { reset(): void } }).__skriveLatency?.reset();
  });
}

async function snapshot(page: Page, kinds?: string[]): Promise<Snapshot> {
  const snap = await page.evaluate((k) => {
    const probe = (window as unknown as {
      __skriveLatency?: { snapshot(kinds?: string[]): Snapshot };
    }).__skriveLatency;
    return probe ? probe.snapshot(k) : null;
  }, kinds);
  expect(snap, 'latency probe returned a snapshot').not.toBeNull();
  return snap as Snapshot;
}

// Record a scenario, assert the measurement is live, and stash the rounded
// summary for the baseline file.
function record(name: string, params: ScenarioRecord['params'], snap: Snapshot): LatencySummary {
  expect(snap.summary.count, `${name}: captured keystroke samples`).toBeGreaterThan(0);
  expect(Number.isFinite(snap.summary.p99), `${name}: finite p99`).toBe(true);
  results[name] = {
    params,
    summary: roundSummary(snap.summary),
    eventTiming: roundSummary(snap.eventTiming),
    sampleCount: snap.sampleCount
  };
  // eslint-disable-next-line no-console
  console.log(
    `[gate] ${name.padEnd(26)} n=${String(snap.summary.count).padStart(3)}  ` +
      `p50=${round2(snap.summary.p50)}ms  p99=${round2(snap.summary.p99)}ms  max=${round2(snap.summary.max)}ms`
  );
  return snap.summary;
}

function recordRatio(name: string, base: LatencySummary, cand: LatencySummary, tolerance: number): void {
  const v = constantTimeRatio(base, cand, tolerance);
  ratios[name] = { ratio: round2(v.ratio), withinTolerance: v.withinTolerance, tolerance };
  // eslint-disable-next-line no-console
  console.log(`[gate] ratio ${name.padEnd(20)} ${round2(v.ratio)}x (tol ${tolerance}x) ${v.withinTolerance ? 'ok' : 'OVER'}`);
}

async function grantClipboard(context: BrowserContext): Promise<void> {
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch {
    // Some channels don't expose these permission names; the paste scenario
    // falls back to insertText below.
  }
}

test('keystroke→paint baseline + adversarial matrix', async ({ page, context }) => {
  await grantClipboard(context);

  // 1) Headline baseline — both surfaces, small doc, caret at the first block.
  let richBaseline: LatencySummary | null = null;
  for (const surface of ['rich', 'text'] as const) {
    await test.step(`baseline:${surface}`, async () => {
      await openHarness(page, { surface, blocks: 200 });
      await caretAt(page, 'SKRIVE_FIRST_BLOCK');
      await resetProbe(page);
      await page.keyboard.type(PARAGRAPH + PARAGRAPH, { delay: 12 });
      const summary = record(`baseline-${surface}`, { surface, blocks: 200 }, await snapshot(page, ['insert']));
      if (surface === 'rich') richBaseline = summary;
    });
  }

  // 2) Constant-time over document size: block 1 of a small doc vs the last
  //    block of a 10k-block doc (Rich; today's Rich renders the whole doc).
  let posSmall: LatencySummary | null = null;
  await test.step('position:rich-200-first', async () => {
    await openHarness(page, { surface: 'rich', blocks: 200 });
    await caretAt(page, 'SKRIVE_FIRST_BLOCK');
    await resetProbe(page);
    await page.keyboard.type(PARAGRAPH, { delay: 12 });
    posSmall = record('position-200-first', { surface: 'rich', blocks: 200 }, await snapshot(page, ['insert']));
  });
  await test.step('position:rich-10k-last', async () => {
    await openHarness(page, { surface: 'rich', blocks: 10_000 });
    await caretAt(page, 'SKRIVE_LAST_BLOCK');
    await resetProbe(page);
    await page.keyboard.type(PARAGRAPH, { delay: 12 });
    const big = record('position-10k-last', { surface: 'rich', blocks: 10_000 }, await snapshot(page, ['insert']));
    if (posSmall) recordRatio('size-10k-vs-200', posSmall, big, GATE.positionTolerance);
  });

  // 3) Anchor-bearing block vs plain block (Rich, mid-size doc).
  await test.step('anchor:rich-anchored-block', async () => {
    await openHarness(page, { surface: 'rich', blocks: 2000, anchors: 50 });
    await caretAt(page, 'SKRIVE_ANCHORED_BLOCK');
    await resetProbe(page);
    await page.keyboard.type(PARAGRAPH, { delay: 12 });
    const anchored = record('anchor-bearing', { surface: 'rich', blocks: 2000, anchors: 50 }, await snapshot(page, ['insert']));
    if (posSmall) recordRatio('anchor-vs-plain', posSmall, anchored, GATE.anchorTolerance);
  });

  // 4) Typing while the cold path churns (main-thread contention proxy).
  await test.step('cold-path:rich-under-load', async () => {
    await openHarness(page, { surface: 'rich', blocks: 2000 });
    await caretAt(page, 'SKRIVE_FIRST_BLOCK');
    await page.evaluate(() => {
      (window as unknown as { __skriveHarness?: { setColdLoad(on: boolean): void } }).__skriveHarness?.setColdLoad(true);
    });
    await resetProbe(page);
    await page.keyboard.type(PARAGRAPH + PARAGRAPH, { delay: 12 });
    await page.evaluate(() => {
      (window as unknown as { __skriveHarness?: { setColdLoad(on: boolean): void } }).__skriveHarness?.setColdLoad(false);
    });
    const cold = record('cold-path-load', { surface: 'rich', blocks: 2000, coldLoad: 1 }, await snapshot(page, ['insert']));
    if (richBaseline) recordRatio('cold-vs-idle', richBaseline, cold, GATE.coldTolerance);
  });

  // 5) IME composition (CDP drives a real composition sequence → insertCompositionText).
  await test.step('ime:rich-composition', async () => {
    await openHarness(page, { surface: 'rich', blocks: 200 });
    await caretAt(page, 'SKRIVE_FIRST_BLOCK');
    await resetProbe(page);
    const cdp = await context.newCDPSession(page);
    const phrases = ['にほんご', 'へんかん', 'ひらがな', 'かんじへ'];
    for (const phrase of phrases) {
      for (let i = 1; i <= phrase.length; i++) {
        await cdp.send('Input.imeSetComposition', {
          text: phrase.slice(0, i),
          selectionStart: i,
          selectionEnd: i
        });
      }
      await cdp.send('Input.insertText', { text: phrase });
    }
    record('ime-composition', { surface: 'rich', blocks: 200 }, await snapshot(page, ['composition', 'insert']));
  });

  // 6) Fast paste. Synthetic Ctrl+V does not paste the real clipboard in
  //    headless Chromium, and ProseMirror preventDefaults the paste event
  //    anyway — so dispatch a genuine `paste` ClipboardEvent carrying the text,
  //    the same path a real paste drives. The probe's `paste` listener stamps it.
  await test.step('paste:rich-fast', async () => {
    await openHarness(page, { surface: 'rich', blocks: 200 });
    await caretAt(page, 'SKRIVE_FIRST_BLOCK');
    await resetProbe(page);
    const blob = PARAGRAPH.repeat(20);
    await page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      const el =
        (document.activeElement as HTMLElement | null) ??
        (document.querySelector('[contenteditable="true"]') as HTMLElement | null);
      el?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, blob);
    // Let the post-paint message resolve the single sample before reading.
    await page.waitForTimeout(50);
    record('paste-fast', { surface: 'rich', blocks: 200 }, await snapshot(page, ['paste', 'insert']));
  });

  // 7) Held-key autorepeat (a long run at maximum cadence).
  await test.step('held-key:rich-autorepeat', async () => {
    await openHarness(page, { surface: 'rich', blocks: 200 });
    await caretAt(page, 'SKRIVE_FIRST_BLOCK');
    await resetProbe(page);
    await page.keyboard.type('a'.repeat(160), { delay: 0 });
    record('held-key-autorepeat', { surface: 'rich', blocks: 200 }, await snapshot(page, ['insert']));
  });

  // Write the baseline artifact. No timestamp on purpose: the file should diff
  // only when the numbers move, so a regression is visible in review.
  const baseline = {
    note: 'Keystroke→paint baseline (SKR-108 Stage 0). Surrogate engine: Chromium. Absolute truth is the shell engine via the in-app overlay. Regenerate: bun run test:latency.',
    gate: GATE,
    scenarios: results,
    ratios
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
});
