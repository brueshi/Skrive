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
import { registerProjectHandlers } from '../ipc/project';
import { registerFsHandlers } from '../ipc/fs';
import { registerDiffHandlers } from '../ipc/diff';
import { registerHistoryHandlers } from '../ipc/history';
import { registerLinksHandlers } from '../ipc/links';
import { registerPersistenceHandlers } from '../ipc/persistence';
import { registerSearchHandlers } from '../ipc/search';
import { registerUpdaterHandlers } from '../ipc/updater';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;

// Dev-only window icon. In packaged builds the OS reads the icon from
// the bundle/exe metadata that electron-builder embeds (mac.icon /
// win.icon), so the BrowserWindow `icon` prop is redundant. In dev
// (electron-vite) the binary is plain Electron with no bundled icon,
// so we point BrowserWindow at the project-root build/icon.png to make
// the dock + Alt-Tab thumbnail show the Skrive mark instead of the
// generic Electron diamond.
function devIconPath(): string {
  return join(__dirname, '../../../build/icon.png');
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
    ...(isDev
      ? { icon: nativeImage.createFromPath(devIconPath()) }
      : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
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
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:platform', () => process.platform);

  // External links from the Preview pane. We validate the scheme so a
  // crafted markdown link can't trigger unexpected handlers (e.g. file://).
  // Allow-list mirrors the Preview's `isExternalHref` set: http(s), mailto,
  // tel, plus the skrive:// deep-link scheme we own.
  ipcMain.handle('links:openExternal', async (_event, url: string) => {
    if (typeof url !== 'string') return;
    const allowed = /^(https?|mailto|tel|skrive):/i;
    if (!allowed.test(url)) return;
    await shell.openExternal(url);
  });

  registerProjectHandlers();
  registerFsHandlers();
  registerDiffHandlers();
  registerLinksHandlers();
  registerPersistenceHandlers();
  registerSearchHandlers();
  registerHistoryHandlers();
  registerUpdaterHandlers();
}

void app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
