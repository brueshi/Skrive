// Keystroke spike matrix (SKR-109) — the existential fork, measured.
//
// Drives the two framework-free contenteditable variants (single host vs
// per-block hosts) through the gate's adversarial scenarios and asks: does a
// glyph land in CONSTANT time at 10k blocks (block-10k p99 within tolerance of
// block-1), and do IME and a bulk insert hold? Today's editor — a single
// ProseMirror contenteditable — is 27x at 10k (harness/baseline.latency.json), so
// the bar here is a hard one: ratio <= TOL.
//
// Outcome: records every number to harness/bespoke.latency.json and asserts the
// FORK — at least one variant clears constant-time AND lands IME. Pass => Stage 3
// builds the real surface on the winning structure; a red here means neither
// bespoke structure held and the finding routes to the ProseMirror fallback.

import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { constantTimeRatio, type LatencySummary } from '../app/src/lib/instrumentation/stats';

const OUT_PATH = fileURLToPath(new URL('bespoke.latency.json', import.meta.url));

// Constant-time tolerance: a glyph at block 10k may be at most TOL x the cost at
// block 1. Generous enough to absorb measurement noise at 10k, tight enough that
// today's 27x is nowhere near passing.
const TOL = 2.0;

const VARIANTS = ['bespoke-single', 'bespoke-perblock'] as const;
type Variant = (typeof VARIANTS)[number];

const PARAGRAPH = 'the quick brown fox jumps over the lazy dog and keeps on writing ';
const IME_PHRASES = ['にほんご', 'へんかん', 'ひらがな'];

type VariantResult = {
  scenarios: Record<string, LatencySummary>;
  ratios: Record<string, { ratio: number; withinTolerance: boolean }>;
  constantTime: boolean;
  ime: { landed: boolean; summary: LatencySummary };
  crossBlockSelection: boolean;
};
const results: Record<string, VariantResult> = {};

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

async function open(page: Page, surface: Variant, blocks: number, anchors = 0): Promise<void> {
  await page.goto(`/harness.html?surface=${surface}&blocks=${blocks}&anchors=${anchors}`);
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

async function summary(page: Page, kinds: string[]): Promise<LatencySummary> {
  // The post-paint sampler resolves asynchronously (rAF + MessageChannel), so a
  // fast burst can finish before its last samples are recorded. Let the queue
  // drain before reading, or a rapid scenario undercounts.
  await page.waitForTimeout(80);
  const snap = await page.evaluate((k) => {
    const probe = (window as unknown as {
      __skriveLatency?: { snapshot(kinds?: string[]): { summary: LatencySummary } };
    }).__skriveLatency;
    return probe ? probe.snapshot(k).summary : null;
  }, kinds);
  expect(snap, 'probe returned a summary').not.toBeNull();
  const s = snap as LatencySummary;
  expect(s.count, 'captured samples').toBeGreaterThan(0);
  return s;
}

function log(variant: string, label: string, s: LatencySummary): void {
  // eslint-disable-next-line no-console
  console.log(
    `[spike] ${variant.padEnd(17)} ${label.padEnd(16)} n=${String(s.count).padStart(3)}  ` +
      `p50=${round2(s.p50)}ms  p99=${round2(s.p99)}ms  max=${round2(s.max)}ms`
  );
}

test('keystroke spike: constant-time + IME across both contenteditable structures', async ({ page, context }) => {
  for (const variant of VARIANTS) {
    const scenarios: Record<string, LatencySummary> = {};
    const ratios: VariantResult['ratios'] = {};

    // 1) Block 1 of a small doc — the reference cost.
    await test.step(`${variant}:small-first`, async () => {
      await open(page, variant, 200);
      await caretAt(page, 'SKRIVE_FIRST_BLOCK');
      await resetProbe(page);
      await page.keyboard.type(PARAGRAPH, { delay: 12 });
      scenarios['small-first'] = roundSummary(await summary(page, ['insert']));
      log(variant, 'small-first', scenarios['small-first']!);
    });

    // 2) Last block of a 10k doc — the constant-time test.
    await test.step(`${variant}:big-last`, async () => {
      await open(page, variant, 10_000);
      await caretAt(page, 'SKRIVE_LAST_BLOCK');
      await resetProbe(page);
      await page.keyboard.type(PARAGRAPH, { delay: 12 });
      scenarios['big-last'] = roundSummary(await summary(page, ['insert']));
      log(variant, 'big-last', scenarios['big-last']!);
      const v = constantTimeRatio(scenarios['small-first']!, scenarios['big-last']!, TOL);
      ratios['size-10k-vs-200'] = { ratio: round2(v.ratio), withinTolerance: v.withinTolerance };
      // eslint-disable-next-line no-console
      console.log(`[spike] ${variant} constant-time ratio ${round2(v.ratio)}x (tol ${TOL}x) ${v.withinTolerance ? 'OK' : 'OVER'}`);
    });

    // 3) Anchor-bearing region.
    await test.step(`${variant}:anchor`, async () => {
      await open(page, variant, 2000, 50);
      await caretAt(page, 'SKRIVE_ANCHORED_BLOCK');
      await resetProbe(page);
      await page.keyboard.type(PARAGRAPH, { delay: 12 });
      scenarios['anchor'] = roundSummary(await summary(page, ['insert']));
      log(variant, 'anchor', scenarios['anchor']!);
    });

    // 4) Typing under cold-path contention.
    await test.step(`${variant}:cold-path`, async () => {
      await open(page, variant, 2000);
      await caretAt(page, 'SKRIVE_FIRST_BLOCK');
      await page.evaluate(() => {
        (window as unknown as { __skriveHarness?: { setColdLoad(on: boolean): void } }).__skriveHarness?.setColdLoad(true);
      });
      await resetProbe(page);
      await page.keyboard.type(PARAGRAPH, { delay: 12 });
      await page.evaluate(() => {
        (window as unknown as { __skriveHarness?: { setColdLoad(on: boolean): void } }).__skriveHarness?.setColdLoad(false);
      });
      scenarios['cold-path'] = roundSummary(await summary(page, ['insert']));
      log(variant, 'cold-path', scenarios['cold-path']!);
    });

    // 5) Held-key autorepeat.
    await test.step(`${variant}:held-key`, async () => {
      await open(page, variant, 200);
      await caretAt(page, 'SKRIVE_FIRST_BLOCK');
      await resetProbe(page);
      await page.keyboard.type('a'.repeat(160), { delay: 0 });
      scenarios['held-key'] = roundSummary(await summary(page, ['insert']));
      log(variant, 'held-key', scenarios['held-key']!);
    });

    // 6) Paste — a real paste event the surface handles imperatively (one large
    //    block-local insert). Dispatched synthetically because headless Chromium
    //    will not paste the system clipboard via Ctrl+V.
    await test.step(`${variant}:paste`, async () => {
      await open(page, variant, 200);
      await caretAt(page, 'SKRIVE_FIRST_BLOCK');
      await resetProbe(page);
      const blob = PARAGRAPH.repeat(20);
      await page.evaluate((t) => {
        const dt = new DataTransfer();
        dt.setData('text/plain', t);
        const el = (document.activeElement as HTMLElement | null) ?? document.querySelector('.bespoke');
        el?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, blob);
      scenarios['paste'] = roundSummary(await summary(page, ['paste', 'insert']));
      log(variant, 'paste', scenarios['paste']!);
    });

    // 7) IME composition — does it HOLD (text lands) and at what cost?
    let ime: VariantResult['ime'] = { landed: false, summary: scenarios['small-first']! };
    await test.step(`${variant}:ime`, async () => {
      await open(page, variant, 200);
      await caretAt(page, 'SKRIVE_FIRST_BLOCK');
      await resetProbe(page);
      const cdp = await context.newCDPSession(page);
      for (const phrase of IME_PHRASES) {
        for (let i = 1; i <= phrase.length; i++) {
          await cdp.send('Input.imeSetComposition', { text: phrase.slice(0, i), selectionStart: i, selectionEnd: i });
        }
        await cdp.send('Input.insertText', { text: phrase });
      }
      const landed = await page.evaluate(
        (phrases) => {
          const text = document.querySelector('.bespoke')?.textContent ?? '';
          return phrases.every((p) => text.includes(p));
        },
        IME_PHRASES
      );
      const s = roundSummary(await summary(page, ['composition', 'insert']));
      ime = { landed, summary: s };
      log(variant, `ime(${landed ? 'landed' : 'LOST'})`, s);
    });

    // Cross-block selection probe (documented, not asserted): from a block's end,
    // does Shift+ArrowDown extend the selection into the next block? Native in a
    // single host; not in separate per-block hosts (the seam the ticket names).
    let crossBlockSelection = false;
    await test.step(`${variant}:selection-boundary`, async () => {
      await open(page, variant, 200);
      await caretAt(page, 'SKRIVE_FIRST_BLOCK');
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+End');
      crossBlockSelection = await page.evaluate(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.collapsed) return false;
        // The selection spans a boundary if its start and end resolve to
        // different .bespoke-block elements.
        const blockOf = (n: Node | null) =>
          (n && (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest('.bespoke-block')) ?? null;
        return blockOf(range.startContainer) !== blockOf(range.endContainer);
      });
      // eslint-disable-next-line no-console
      console.log(`[spike] ${variant} cross-block selection: ${crossBlockSelection ? 'native' : 'not native (Stage 3 seam)'}`);
    });

    const constantTime = ratios['size-10k-vs-200']?.withinTolerance === true;
    results[variant] = { scenarios, ratios, constantTime, ime, crossBlockSelection };
  }

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        note: 'Keystroke spike (SKR-109). Surrogate engine: Chromium. Constant-time tolerance: block-10k p99 <= ' + TOL + 'x block-1.',
        tolerance: TOL,
        variants: results
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  // The fork. The spike succeeds if at least one structure clears constant-time
  // AND lands IME — that structure is what Stage 3 builds on. A red here is the
  // documented FALLBACK signal: neither bespoke structure held, ride ProseMirror.
  const viable = VARIANTS.filter((v) => results[v]?.constantTime && results[v]?.ime.landed);
  // eslint-disable-next-line no-console
  console.log(`[spike] viable structures: ${viable.length ? viable.join(', ') : 'NONE — fork to ProseMirror fallback'}`);
  expect(viable.length, 'at least one bespoke structure clears constant-time and holds IME').toBeGreaterThan(0);
});
