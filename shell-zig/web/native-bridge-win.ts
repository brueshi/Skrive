// Renderer-side native transport for the Windows host (Stage 5.1). Injected by
// the Zig host via WebView2's AddScriptToExecuteOnDocumentCreated, so
// `window.skrive` exists before the app bundle's module script runs.
//
// The Windows twin of native-bridge.ts: same composite (the native channel for
// NATIVE_COMMANDS, the Stage 0.2 MockTransport for everything the core doesn't
// implement yet), only the native channel differs — WebView2's
// `window.chrome.webview.postMessage` out, the host's `__skriveDispatch` in
// (vs WKWebView's `messageHandlers`). The two files are deliberately kept
// separate so the macOS bundle stays byte-identical; a shared core is a later
// refactor once both shells build in one place.

import { createSkriveBridge } from '../../shared/src/bridge';
import type { SkriveTransport } from '../../shared/src/bridge';
import { MockTransport } from '../../shared/__test__/mock-transport';
import { NATIVE_COMMANDS, SAMPLE_ROOT } from './sample-data';

type Envelope = {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  event?: string;
  payload?: Record<string, unknown>;
};

type WebView2Host = { postMessage(message: unknown): void };

// The custom-chrome API the renderer's WindowControls uses (B3). Present only
// in this frameless Windows host; absent on macOS/Electron, where the OS draws
// the window controls. The renderer feature-detects `__SKRIVE_FRAMELESS__`.
type SkriveWindowApi = {
  minimize(): Promise<unknown>;
  toggleMaximize(): Promise<unknown>;
  close(): Promise<unknown>;
  isMaximized(): Promise<{ maximized: boolean }>;
  onMaximizeChanged(cb: (maximized: boolean) => void): () => void;
};

declare global {
  interface Window {
    chrome?: { webview?: WebView2Host };
    __skriveDispatch?: (json: string) => void;
    skrive?: ReturnType<typeof createSkriveBridge>;
    __SKRIVE_FRAMELESS__?: boolean;
    __skriveWindow?: SkriveWindowApi;
  }
}

// ---- native channel -------------------------------------------------------

const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let nextRequestId = 1;

function nativeInvoke(
  cmd: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const host = window.chrome?.webview;
  if (!host) return Promise.reject(new Error('native transport unavailable'));
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // WebView2: a string arg arrives at the host as
    // TryGetWebMessageAsString, matching the macOS postMessage path.
    host.postMessage(JSON.stringify({ v: 1, id, cmd, payload }));
  });
}

// The single fixed entry point the host calls (Part I delivery rule). The host
// hands us a parsed-then-reescaped JSON string; we resolve the pending request
// or fan an event out to subscribers.
window.__skriveDispatch = (json: string) => {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(json) as Envelope;
  } catch {
    return;
  }
  if (typeof envelope.id === 'number') {
    const entry = pending.get(envelope.id);
    if (!entry) return;
    pending.delete(envelope.id);
    if (envelope.ok) entry.resolve(envelope.result);
    else entry.reject(new Error(envelope.error?.message ?? 'shell error'));
    return;
  }
  if (typeof envelope.event === 'string') {
    mock.emit(envelope.event, envelope.payload ?? {});
  }
};

// ---- canned project -------------------------------------------------------

// fs/project/persistence/watcher are native (see NATIVE_COMMANDS). What remains
// canned: app:platform, history (Stage 4, not ported), updater (Stage 6). The
// app boots to its welcome state — native persistence returns the default
// app-state with no last-opened project, so nothing auto-opens until the user
// picks a folder.
const mock = new MockTransport();
mock.stub('history:getMode', { mode: 'checkpoint' });
mock.stub('history:setGitHistoryEnabled', { mode: 'checkpoint' });
mock.stub('app:platform', { platform: 'win32' });
mock.stub('updater:current', { kind: 'idle' });

// ---- composite transport --------------------------------------------------

const transport: SkriveTransport = {
  invoke(cmd, payload) {
    if (NATIVE_COMMANDS.has(cmd)) return nativeInvoke(cmd, payload);
    return mock.invoke(cmd, payload);
  },
  on(event, handler) {
    return mock.on(event, handler);
  }
};

window.skrive = createSkriveBridge(transport);

// B3 custom frameless chrome: this host draws no native title bar, so the
// renderer owns the window controls. Advertise frameless mode (read
// synchronously by the renderer before first paint, no flicker) and expose the
// window-control API the WindowControls component calls. These globals exist
// only here — Electron and the macOS host never set them, so the renderer
// keeps the OS title bar there. window:* are host-owned commands (routed in
// app.zig), invoked directly off the native channel rather than the contract.
window.__SKRIVE_FRAMELESS__ = true;
window.__skriveWindow = {
  minimize: () => nativeInvoke('window:minimize', {}),
  toggleMaximize: () => nativeInvoke('window:toggleMaximize', {}),
  close: () => nativeInvoke('window:close', {}),
  isMaximized: () =>
    nativeInvoke('window:isMaximized', {}) as Promise<{ maximized: boolean }>,
  onMaximizeChanged: (cb) =>
    mock.on('window:maximizeChanged', (payload) =>
      cb(Boolean((payload as { maximized?: boolean }).maximized))
    )
};

// Test-only hook: lets a future SKRIVE_DIAG self-test drive the native channel
// directly (e.g. diag:poison for the delivery-rule round-trip) without adding a
// contract method. Host-build only; the real bridge never exposes this.
(window as unknown as {
  __skriveNativeInvoke?: typeof nativeInvoke;
}).__skriveNativeInvoke = nativeInvoke;

(window as unknown as { __skriveSampleRoot?: string }).__skriveSampleRoot =
  SAMPLE_ROOT;
