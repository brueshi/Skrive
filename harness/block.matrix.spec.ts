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

test('Stage 3b: Enter splits a block and Backspace merges it back', async ({ page }) => {
  await open(page, 5);
  const before = await page.evaluate(() => window.__skriveBlockSurface!.blockCount());

  // Caret at the end of the first block, split with Enter, type into the new block.
  await caretAt(page, 'SKRIVE_FIRST_BLOCK');
  await page.keyboard.press('Enter');
  await page.keyboard.type('NEWBLOCKZZ', { delay: 8 });
  await page.waitForTimeout(80);

  expect(await page.evaluate(() => window.__skriveBlockSurface!.blockCount())).toBe(before + 1);
  let md = await serialized(page);
  expect(md, 'split block content present').toContain('NEWBLOCKZZ');
  expect(serializeDocument(parseDocument(md)), 'stable after split').toBe(md);

  // Backspace at the start of the new block merges it back into the first.
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);

  expect(await page.evaluate(() => window.__skriveBlockSurface!.blockCount())).toBe(before);
  md = await serialized(page);
  expect(md, 'merged content retained').toContain('NEWBLOCKZZ');
  expect(serializeDocument(parseDocument(md)), 'stable after merge').toBe(md);
});

test('Stage 3b: Delete at a block end merges the next block in', async ({ page }) => {
  await open(page, 5);
  const before = await page.evaluate(() => window.__skriveBlockSurface!.blockCount());

  await caretAt(page, 'SKRIVE_FIRST_BLOCK'); // caret at end of block 1
  await page.keyboard.press('Delete'); // pull block 2 up into block 1
  await page.waitForTimeout(80);

  expect(await page.evaluate(() => window.__skriveBlockSurface!.blockCount())).toBe(before - 1);
  const md = await serialized(page);
  expect(serializeDocument(parseDocument(md)), 'stable after forward-merge').toBe(md);
});

// Focus the first block, append a sentinel word, and leave it selected.
async function selectSentinel(page: Page, word: string): Promise<void> {
  await caretAt(page, 'SKRIVE_FIRST_BLOCK');
  await page.keyboard.type(` ${word}`, { delay: 6 });
  for (let i = 0; i < word.length; i++) await page.keyboard.press('Shift+ArrowLeft');
}

test('Stage 3c: bold toggles on and off via the keyboard', async ({ page }) => {
  await open(page, 5);
  await selectSentinel(page, 'BOLDME');

  await page.keyboard.press('ControlOrMeta+b');
  await page.waitForTimeout(80);
  let md = await serialized(page);
  expect(md, 'bold applied').toContain('**BOLDME**');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);

  await page.keyboard.press('ControlOrMeta+b');
  await page.waitForTimeout(80);
  md = await serialized(page);
  expect(md, 'bold removed').not.toContain('**BOLDME**');
  expect(md).toContain('BOLDME');
});

test('Stage 3c: italic and inline code via the keyboard', async ({ page }) => {
  await open(page, 5);
  await selectSentinel(page, 'EMME');
  await page.keyboard.press('ControlOrMeta+i');
  await page.waitForTimeout(80);
  expect(await serialized(page)).toContain('*EMME*');

  await open(page, 5);
  await selectSentinel(page, 'CODEME');
  await page.keyboard.press('ControlOrMeta+e');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md).toContain('`CODEME`');
  expect(serializeDocument(parseDocument(md))).toBe(md);
});

test('Stage 3c: the select->bubble applies bold and a link', async ({ page }) => {
  await open(page, 5);
  await selectSentinel(page, 'BUBBLEME');

  const bold = page.getByRole('button', { name: 'Bold (Cmd/Ctrl+B)' });
  await expect(bold, 'bubble appears on selection').toBeVisible();
  await bold.click();
  await page.waitForTimeout(80);
  expect(await serialized(page)).toContain('**BUBBLEME**');

  // Selection is preserved after the mark, so the bubble stays — add a link.
  await page.getByRole('button', { name: 'Link' }).click();
  const input = page.getByPlaceholder('https://…');
  await expect(input).toBeVisible();
  await input.fill('https://skrive.md');
  await input.press('Enter');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md, 'link applied over the bolded text').toContain('](https://skrive.md)');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3c: bold applies across a multi-block selection', async ({ page }) => {
  await open(page, 5);
  await caretAt(page, 'SKRIVE_FIRST_BLOCK'); // focus the editable

  // Select the full text of the first two top-level blocks, end to end — the
  // "select several paragraphs and bold them all at once" case.
  await page.evaluate(() => {
    const root = document.querySelector('.bespoke-root');
    if (!root) throw new Error('no surface root');
    const blocks = root.querySelectorAll('[data-block-id]');
    const a = blocks[0] as HTMLElement;
    const b = blocks[1] as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(a);
    range.setEnd(b, b.childNodes.length);
    const sel = window.getSelection();
    if (!sel) throw new Error('no selection');
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });

  await page.keyboard.press('ControlOrMeta+b');
  await page.waitForTimeout(80);

  const md = await serialized(page);
  const boldBlocks = md.split('\n\n').filter((blk) => {
    const t = blk.trim();
    return t.startsWith('**') && t.endsWith('**');
  });
  expect(boldBlocks.length, 'both blocks bolded as one action').toBeGreaterThanOrEqual(2);
  expect(serializeDocument(parseDocument(md)), 'stable after multi-block bold').toBe(md);
});

test('Stage 3d: slash menu converts a block to a heading', async ({ page }) => {
  await open(page, 5);
  // Make a fresh empty block, then open the insert menu with `/`.
  await caretAt(page, 'SKRIVE_FIRST_BLOCK');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(page.getByRole('listbox', { name: 'Insert block' }), 'menu opens on /').toBeVisible();

  // Filter to headings and pick the first (Heading 1) with Enter.
  await page.keyboard.type('head');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  await page.keyboard.type('My Title');
  await page.waitForTimeout(80);

  const md = await serialized(page);
  expect(md, 'block became a heading').toContain('# My Title');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3d: slash menu inserts a divider', async ({ page }) => {
  await open(page, 5);
  await caretAt(page, 'SKRIVE_FIRST_BLOCK');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(page.getByRole('listbox', { name: 'Insert block' })).toBeVisible();
  await page.keyboard.type('div');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  await page.keyboard.type('below the rule');
  await page.waitForTimeout(80);

  const md = await serialized(page);
  expect(md, 'a thematic break was inserted').toMatch(/(^|\n)---(\n|$)/);
  expect(md).toContain('below the rule');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3d: Escape closes the menu and a mid-text slash does not open it', async ({ page }) => {
  await open(page, 5);
  await caretAt(page, 'SKRIVE_FIRST_BLOCK');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Insert block' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu, 'Escape closes the menu').toBeHidden();

  // A `/` typed in the middle of prose is just a slash, not a trigger.
  await page.keyboard.type('a/b');
  await expect(menu, 'no menu mid-text').toBeHidden();
});

// Open a fresh empty block and run the insert menu with the given query, picking
// the first match.
async function insertViaMenu(page: Page, query: string): Promise<void> {
  await caretAt(page, 'SKRIVE_FIRST_BLOCK');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`/${query}`);
  await expect(page.getByRole('listbox', { name: 'Insert block' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
}

test('Stage 3e: convert to a quote and type inside it', async ({ page }) => {
  await open(page, 5);
  await insertViaMenu(page, 'quote');
  await page.keyboard.type('quoted words');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md, 'content is inside a blockquote').toContain('> quoted words');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3e: convert to a bullet list and type inside it', async ({ page }) => {
  await open(page, 5);
  await insertViaMenu(page, 'bullet');
  await page.keyboard.type('a list item');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md, 'content is a list item').toContain('- a list item');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3e: convert to code and type multiple lines', async ({ page }) => {
  await open(page, 5);
  await insertViaMenu(page, 'code');
  await page.keyboard.type('line1');
  await page.keyboard.press('Enter'); // newline within the code block, not a split
  await page.keyboard.type('line2');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md, 'both lines inside one fenced block').toContain('line1\nline2');
  expect(md).toMatch(/```/);
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3e: marks work inside a container', async ({ page }) => {
  await open(page, 5);
  await insertViaMenu(page, 'quote');
  await page.keyboard.type('BOLDQ');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ControlOrMeta+b');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md, 'bold applied inside the quote').toContain('**BOLDQ**');
  expect(md).toContain('>');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3f: Enter in a list starts a new item', async ({ page }) => {
  await open(page, 5);
  await insertViaMenu(page, 'bullet');
  await page.keyboard.type('first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md).toContain('- first');
  expect(md).toContain('- second');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3f: Enter on an empty list item exits the list', async ({ page }) => {
  await open(page, 5);
  await insertViaMenu(page, 'bullet');
  await page.keyboard.type('only item');
  await page.keyboard.press('Enter'); // new empty item
  await page.keyboard.press('Enter'); // empty -> exit the list
  await page.keyboard.type('after the list');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md).toContain('- only item');
  expect(md, 'escaped text is a paragraph, not a list item').toContain('after the list');
  expect(md).not.toContain('- after the list');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3f: Enter in a quote adds a line', async ({ page }) => {
  await open(page, 5);
  await insertViaMenu(page, 'quote');
  await page.keyboard.type('line one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line two');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md).toContain('> line one');
  expect(md).toContain('> line two');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3g: insert a table and fill cells with Tab', async ({ page }) => {
  await open(page, 5);
  await insertViaMenu(page, 'table');
  await page.keyboard.type('H1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('H2');
  await page.keyboard.press('Tab');
  await page.keyboard.type('a');
  await page.keyboard.press('Tab');
  await page.keyboard.type('b');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md, 'header row').toContain('| H1 | H2 |');
  expect(md, 'body row').toContain('| a | b |');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
});

test('Stage 3g: marks work inside a table cell', async ({ page }) => {
  await open(page, 5);
  await insertViaMenu(page, 'table');
  await page.keyboard.type('BOLDCELL');
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ControlOrMeta+b');
  await page.waitForTimeout(80);
  const md = await serialized(page);
  expect(md, 'bold applied in the cell').toContain('**BOLDCELL**');
  expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);
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
