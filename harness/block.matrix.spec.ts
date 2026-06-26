// Stage 3a gate (SKR-95): the real bespoke surface (surface=block) — the engine
// core (render + selection + prose typing) over the canonical block model.
//
// Two things must hold at 3a: the keystroke→paint gate stays constant-time with
// REAL render + selection mapping (not the spike's plain text), and the model
// stays authoritative and faithful — typing re-serializes to Markdown that keeps
// untouched blocks byte-pristine and is round-trip stable.

import { test, expect, type Page } from '@playwright/test';
import { constantTimeRatio, type LatencySummary } from '../app/src/lib/instrumentation/stats';
import { parseDocument, serializeDocument } from '../app/src/lib/blockmodel';

const TOL = 2.0;
const PARAGRAPH = 'the quick brown fox jumps over the lazy dog and keeps on writing ';

async function open(page: Page, blocks: number): Promise<void> {
  await page.goto(`/harness.html?surface=block&blocks=${blocks}`);
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

async function summary(page: Page): Promise<LatencySummary> {
  await page.waitForTimeout(80);
  const s = await page.evaluate(() => {
    const probe = (window as unknown as {
      __skriveLatency?: { snapshot(kinds?: string[]): { summary: LatencySummary } };
    }).__skriveLatency;
    return probe ? probe.snapshot(['insert']).summary : null;
  });
  expect(s, 'probe summary').not.toBeNull();
  expect((s as LatencySummary).count, 'captured samples').toBeGreaterThan(0);
  return s as LatencySummary;
}

async function serialized(page: Page): Promise<string> {
  const out = await page.evaluate(() => window.__skriveBlockSurface?.serialize() ?? null);
  expect(out, 'block surface exposed serialize()').not.toBeNull();
  return out as string;
}

test('Stage 3a: the bespoke engine types constant-time', async ({ page }) => {
  await open(page, 200);
  await caretAt(page, 'SKRIVE_FIRST_BLOCK');
  await page.evaluate(() => (window as unknown as { __skriveLatency?: { reset(): void } }).__skriveLatency?.reset());
  await page.keyboard.type(PARAGRAPH, { delay: 12 });
  const small = await summary(page);

  await open(page, 10_000);
  await caretAt(page, 'SKRIVE_LAST_BLOCK');
  await page.evaluate(() => (window as unknown as { __skriveLatency?: { reset(): void } }).__skriveLatency?.reset());
  await page.keyboard.type(PARAGRAPH, { delay: 12 });
  const big = await summary(page);

  const v = constantTimeRatio(small, big, TOL);
  // eslint-disable-next-line no-console
  console.log(`[3a] block-1 p99=${small.p99}ms  block-10k p99=${big.p99}ms  ratio=${v.ratio.toFixed(2)}x (tol ${TOL}x)`);
  expect(v.withinTolerance, `constant-time (ratio ${v.ratio.toFixed(2)}x)`).toBe(true);
});

test('Stage 3a: the model stays authoritative and faithful', async ({ page }) => {
  await open(page, 200);

  // The freshly rendered surface re-serializes to a fidelity-stable document.
  const before = await serialized(page);
  expect(serializeDocument(parseDocument(before)), 'round-trip stable before edit').toBe(before);

  // Type a sentinel into the first block; the edit lands and the tail block is
  // untouched (its marker text survives byte-for-byte).
  await caretAt(page, 'SKRIVE_FIRST_BLOCK');
  await page.keyboard.type(' ZZZEDIT', { delay: 8 });
  await page.waitForTimeout(80);

  const after = await serialized(page);
  expect(after, 'edit landed in the model').toContain('ZZZEDIT');
  expect(after, 'an untouched block stayed intact').toContain('SKRIVE_LAST_BLOCK');
  expect(serializeDocument(parseDocument(after)), 'edited output is round-trip stable').toBe(after);
});

test('Stage 3a: IME composition lands in the model', async ({ page, context }) => {
  await open(page, 200);
  await caretAt(page, 'SKRIVE_FIRST_BLOCK');
  const cdp = await context.newCDPSession(page);
  const phrase = 'にほんご';
  for (let i = 1; i <= phrase.length; i++) {
    await cdp.send('Input.imeSetComposition', { text: phrase.slice(0, i), selectionStart: i, selectionEnd: i });
  }
  await cdp.send('Input.insertText', { text: phrase });
  await page.waitForTimeout(80);
  expect(await serialized(page), 'composed text reconciled into the model').toContain(phrase);
});
