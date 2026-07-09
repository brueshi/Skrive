// Renderer-side native transport for the Stage 1 macOS spike. Injected by
// the Swift host as a WKUserScript at document start, so `window.skrive`
// exists before the app bundle's module script runs.
//
// It composes two sources behind the one tested `createSkriveBridge`
// mapping (Stage 0.2):
//   - the native channel (WKScriptMessageHandler in, the host's
//     __skriveDispatch out) for commands the Zig core implements, and
//   - the Stage 0.2 MockTransport, preloaded with a read-only sample
//     project, for everything else.
//
// As the Zig core grows in Stage 2, commands migrate from the mock to the
// native channel by adding their names to NATIVE_COMMANDS — `app/` and
// `shared/` never change.

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

type InvokeHost = { postMessage(message: string): void };

declare global {
  interface Window {
    webkit?: { messageHandlers?: { skriveInvoke?: InvokeHost } };
    __skriveDispatch?: (json: string) => void;
    skrive?: ReturnType<typeof createSkriveBridge>;
    // Tells the renderer the host owns updates (Sparkle), so it hides its
    // in-app updater controls. See SettingsView's NativeUpdatesPane.
    __SKRIVE_NATIVE_UPDATER__?: boolean;
    // Marks "this renderer is hosted by the native shell" (vs Electron). Set on
    // both native shells; Electron loads no bridge so it's absent there.
    __SKRIVE_NATIVE_SHELL__?: boolean;
    // macOS-only window dragging (SKR-240). Absent on every other host.
    __skriveWindowDrag?: { start(): void; toggleZoom(): void };
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
  const host = window.webkit?.messageHandlers?.skriveInvoke;
  if (!host) return Promise.reject(new Error('native transport unavailable'));
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.postMessage(JSON.stringify({ v: 1, id, cmd, payload }));
  });
}

/** Fire-and-forget host command. The host replies to nothing here, so unlike
 *  `nativeInvoke` this registers no pending promise — one that could never settle
 *  would leak an entry per call, and a window drag is one per mousedown. The `id` is
 *  still sent: the host's parser requires the field before it routes anything. */
function nativeNotify(cmd: string): void {
  const host = window.webkit?.messageHandlers?.skriveInvoke;
  if (!host) return;
  host.postMessage(JSON.stringify({ v: 1, id: nextRequestId++, cmd, payload: {} }));
}

// The single fixed entry point the host calls (Part I delivery rule). The
// host hands us a parsed-then-reescaped JSON string; we resolve the pending
// request or fan an event out to subscribers.
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

// fs/project/persistence are native as of Stage 2.5 (see NATIVE_COMMANDS).
// What remains canned: app:platform (2.5b), history (Stage 4). Updates are
// no longer mocked here: Stage 6 drives them through Sparkle natively (its
// own dialogs + the host's "Check for Updates…" menu item), and the renderer
// hides its in-app updater controls via __SKRIVE_NATIVE_UPDATER__ below, so
// the updater:* contract methods are simply never invoked on this shell. The
// app boots to its welcome state — native persistence returns the default
// app-state with no last-opened project, so nothing auto-opens until the user
// picks a folder via project:openDialog.
const mock = new MockTransport();
mock.stub('history:getMode', { mode: 'checkpoint' });
mock.stub('history:setGitHistoryEnabled', { mode: 'checkpoint' });
mock.stub('app:platform', { platform: 'darwin' });

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

// The macOS host drives Sparkle through a custom SPUUserDriver that streams
// update state over the updater:status contract, so the renderer's own
// contract-driven updater UI (Settings pane + launch toast) is in charge — not
// Sparkle's stock dialogs. Leave this flag unset so that UI renders. (The
// Windows host still uses WinSparkle's native dialogs and keeps the flag true.)
window.__SKRIVE_NATIVE_UPDATER__ = false;

// This renderer runs inside the native shell (not Electron). The renderer reads
// this to suppress Electron-only flows like the M4a migration notice. Kept
// separate from the updater flag above, which means something different.
window.__SKRIVE_NATIVE_SHELL__ = true;

// Window dragging for the macOS host (SKR-240). The renderer's topbar carries
// `-webkit-app-region: drag`, a Chromium extension WKWebView does not implement — so
// on this host the header must ask AppKit to drag the window itself. Deliberately a
// SEPARATE global from the Windows host's `__skriveWindow` (minimize / maximize /
// close): the two hosts expose different chrome, and merging them would force one
// shell's API to go optional in the other's types. Its absence is the feature test.
window.__skriveWindowDrag = {
  start: () => nativeNotify('window:startDrag'),
  toggleZoom: () => nativeNotify('window:toggleZoom')
};

// Test-only hook: lets the SKRIVE_DIAG self-test drive the native channel
// directly (e.g. diag:poison for the 1.4 delivery-rule round-trip) without
// adding a contract method. Spike-only; the real bridge never exposes this.
(window as unknown as {
  __skriveNativeInvoke?: typeof nativeInvoke;
}).__skriveNativeInvoke = nativeInvoke;

// Surface the sample root for manual debugging in the web inspector.
(window as unknown as { __skriveSampleRoot?: string }).__skriveSampleRoot =
  SAMPLE_ROOT;
