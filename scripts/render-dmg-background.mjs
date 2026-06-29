// Rasterize the DMG install-window background (SKR-122) from its SVG source to
// @1x and @2x PNGs, using the Playwright chromium already pulled in for the
// latency harness — so we depend on no new image tooling and text renders with
// real fonts. The two PNGs are committed and then bundled into a single HiDPI
// background.tiff by release-macos.sh (via tiffutil), so the release pipeline
// and CI never need a rasterizer or display fonts. Re-run this whenever
// background.svg changes:  node scripts/render-dmg-background.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const W = 760;
const H = 470;
const dir = path.resolve('shell-zig/macos/dmg');
const svg = readFileSync(path.join(dir, 'background.svg'), 'utf8');
const html = `<!doctype html><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#f6f7f9}</style>${svg}`;

const browser = await chromium.launch();
try {
  for (const [scale, name] of [
    [1, 'background.png'],
    [2, 'background@2x.png']
  ]) {
    const page = await browser.newPage({
      viewport: { width: W, height: H },
      deviceScaleFactor: scale
    });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.screenshot({
      path: path.join(dir, name),
      clip: { x: 0, y: 0, width: W, height: H }
    });
    await page.close();
    console.log(`wrote ${name} (${W * scale}x${H * scale})`);
  }
} finally {
  await browser.close();
}
