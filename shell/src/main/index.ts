import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell
} from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SKRIVE_EVENT_CHANNEL,
  SKRIVE_INVOKE_CHANNEL,
  type SkrivePlatform
} from '@skrive/shared';
import {
  dispatchJson,
  emitEvent,
  registerCommand,
  setEventSink
} from './dispatch';
import { registerAssetProtocol, registerAssetScheme } from './asset-protocol';
import { registerProjectHandlers } from '../ipc/project';
import { registerClipboardHandlers } from '../ipc/clipboard';
import { registerFsHandlers } from '../ipc/fs';
import { registerDiffHandlers } from '../ipc/diff';
import { registerHistoryHandlers } from '../ipc/history';
import { registerPersistenceHandlers } from '../ipc/persistence';
import { registerUpdaterHandlers } from '../ipc/updater';
// App-icon tiles bundled via electron-vite's `?asset` (resolves in dev and
// packaged). icon.png is the brand's light tile — the variant electron-
// builder also bakes into the bundle .icns; icon-dark.png is the dark tile.
import iconLight from '../../../build/icon.png?asset';
import iconDark from '../../../build/icon-dark.png?asset';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;

// Privileged scheme registration must happen before the app is ready.
registerAssetScheme();

// macOS dock tile, appearance-aware. The bundle .icns electron-builder
// bakes in is the light tile, and macOS never swaps a flat .icns for dark
// mode, so we swap the *running* dock tile ourselves: the dark brand tile
// under a dark system appearance, the light tile otherwise. Re-applied
// whenever the system appearance changes. Dock-only by design — Finder,
// Launchpad, and the closed-app icon keep the bundle .icns (appearance
// variants there would need a macOS asset catalog electron-builder can't
// produce). No-op off macOS.
function applyDockIcon(): void {
  if (process.platform !== 'darwin') return;
  const tile = nativeTheme.shouldUseDarkColors ? iconDark : iconLight;
  app.dock?.setIcon(nativeImage.createFromPath(tile));
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // Pre-paint flash color. We default to the OS theme rather than
    // hardcoding dark — the renderer's CSS picks the final palette via
    // light-dark() and the user's stored theme pref, but the window
    // background paints first. A theme-aware default keeps the launch
    // flash close to whatever the renderer will end up showing.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#fefcf7',
    // Dev-only window icon (Windows/Linux taskbar + Alt-Tab). In packaged
    // builds the OS reads the icon from the bundle/exe metadata, and on
    // macOS the dock tile is driven by applyDockIcon() instead, so this is
    // a dev fallback to avoid the generic Electron diamond.
    ...(isDev
      ? { icon: nativeImage.createFromPath(iconLight) }
      : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Pushed toward the window edge and raised so the lights' colored
    // circles land on the 40px topbar's centerline (y=20), sharing a
    // baseline with the sidebar toggle beside them.
    trafficLightPosition: { x: 12, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.once('ready-to-show', () => {
    window.show();
    if (isDev) window.webContents.openDevTools({ mode: 'detach' });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpcHandlers(): void {
  // Every request crosses one channel as a JSON-string envelope and
  // flows through the dispatcher; events go out the same way on the
  // event channel. This is the same dispatch surface the parity-fixture
  // harness and the Zig core implement.
  ipcMain.handle(SKRIVE_INVOKE_CHANNEL, (_event, raw: unknown) =>
    dispatchJson(typeof raw === 'string' ? raw : '')
  );
  setEventSink((json) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(SKRIVE_EVENT_CHANNEL, json);
    }
  });

  registerCommand('app:version', () => ({ version: app.getVersion() }));
  registerCommand('app:platform', () => ({
    platform: process.platform as SkrivePlatform
  }));

  // The renderer's ack in the pre-quit flush handshake. Renderer-to-
  // shell traffic is requests-only in the envelope model, so the ack is
  // a command rather than a bare channel send; the before-quit flow
  // below installs the callback while a flush is pending.
  registerCommand('app:flushComplete', () => {
    flushCompleteCallback?.();
    return {};
  });

  // External links from the Preview pane. We validate the scheme so a
  // crafted markdown link can't trigger unexpected handlers (e.g. file://).
  // Allow-list mirrors the Preview's `isExternalHref` set: http(s), mailto,
  // tel, plus the skrive:// deep-link scheme we own. Disallowed input is
  // silently ignored, matching the pre-envelope behavior.
  registerCommand('links:openExternal', async (payload) => {
    const url = payload.url;
    if (typeof url !== 'string') return {};
    const allowed = /^(https?|mailto|tel|skrive):/i;
    if (!allowed.test(url)) return {};
    await shell.openExternal(url);
    return {};
  });

  registerProjectHandlers();
  registerClipboardHandlers();
  registerFsHandlers();
  registerDiffHandlers();
  registerPersistenceHandlers();
  registerHistoryHandlers();
  registerUpdaterHandlers();
}

void app.whenReady().then(() => {
  registerAssetProtocol();
  registerIpcHandlers();
  applyDockIcon();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Swap the macOS dock tile live when the user toggles system appearance.
// Safe to register before `whenReady` — the event only fires at runtime.
nativeTheme.on('updated', applyDockIcon);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Pre-quit flush. The renderer's debounced saves and the Rich surface's pending
// PM->text snapshot may not have reached disk when the user quits. Pause the
// quit once, ask the renderer to flush synchronously, and proceed when it acks
// (or after a short timeout, so a wedged renderer can never trap the app).
let quitFlushed = false;
let quitFlushing = false;
let flushCompleteCallback: (() => void) | null = null;
app.on('before-quit', (event) => {
  if (quitFlushed) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.webContents.isDestroyed()) return;
  event.preventDefault();
  if (quitFlushing) return;
  quitFlushing = true;

  const proceed = () => {
    quitFlushed = true;
    flushCompleteCallback = null;
    app.quit();
  };
  const timer = setTimeout(proceed, 2000);
  flushCompleteCallback = () => {
    clearTimeout(timer);
    proceed();
  };
  emitEvent('app:flush-before-quit', {});
});
