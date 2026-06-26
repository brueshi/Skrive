// Keystroke→paint matrix runner (SKR-108, Stage 0).
//
// Drives the latency harness (app/harness.html) in a real browser and reads the
// gate's numbers from window.__skriveLatency. Chromium is a *regression*
// surrogate — the absolute truth is the shell's own engine (WKWebView /
// WebView2), read live from the in-app overlay. CI watches the surrogate for
// the shape of a regression (a tail that grows with document size); the overlay
// confirms the real-engine number on the device.
//
// The web server is the existing Vite dev server (the native shells already
// point at it via SKRIVE_DEV_URL), so the harness measures the same renderer
// build the app ships.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './',
  testMatch: '**/*.matrix.spec.ts',
  // Latency is a single-tenant measurement: parallel pages would contend for the
  // same CPU and inflate the tails. One worker, serial.
  workers: 1,
  fullyParallel: false,
  // The 10k-block corpus mounts a large DOM on today's (non-virtualised) Rich
  // surface; give scenarios room without masking a genuine hang.
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    // A fixed viewport so layout/paint cost is comparable run to run.
    viewport: { width: 1280, height: 900 }
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:5173/harness.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
