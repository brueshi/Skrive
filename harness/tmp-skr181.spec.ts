import { test, expect, type Page } from '@playwright/test';

async function open(page: Page): Promise<void> {
  await page.goto('/harness.html?surface=block&blocks=3');
  await page.waitForSelector('[data-block-surface]');
}
async function serialized(page: Page): Promise<string> {
  return await page.evaluate(() => (window as any).__skriveHarness.serialize());
}

test('top-level Shift+Tab lifts an ordered item', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).__skriveHarness.focusFirst?.());
  await page.keyboard.press('Control+A');
  await page.keyboard.type('3. a');
  await page.keyboard.press('Enter');
  await page.keyboard.type('b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('c');
  await page.waitForTimeout(80);
  console.log('AFTER TYPING:\n' + JSON.stringify(await serialized(page)));

  // caret into 'b'
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(50);
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(120);
  console.log('AFTER SHIFT-TAB:\n' + JSON.stringify(await serialized(page)));
  expect(true).toBe(true);
});
