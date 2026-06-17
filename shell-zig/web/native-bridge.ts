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
import {
  NATIVE_COMMANDS,
  SAMPLE_ROOT,
  sampleAppState,
  sampleFileContent,
  sampleProjectState,
  sampleSnapshot
} from './sample-data';

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

const mock = new MockTransport();
mock.stub('persistence:loadAppState', sampleAppState());
mock.stub('persistence:loadProjectState', { state: sampleProjectState() });
mock.stub('project:snapshot', sampleSnapshot());
mock.stub('history:getMode', { mode: 'checkpoint' });
mock.stub('history:setGitHistoryEnabled', { mode: 'checkpoint' });
mock.stub('app:platform', { platform: 'darwin' });
mock.stub('updater:current', { kind: 'idle' });

// ---- composite transport --------------------------------------------------

const transport: SkriveTransport = {
  invoke(cmd, payload) {
    if (NATIVE_COMMANDS.has(cmd)) return nativeInvoke(cmd, payload);
    // The mock keys on command name only; reads need the path.
    if (cmd === 'fs:readFile') {
      return Promise.resolve(sampleFileContent(payload.relPath as string));
    }
    return mock.invoke(cmd, payload);
  },
  on(event, handler) {
    return mock.on(event, handler);
  }
};

window.skrive = createSkriveBridge(transport);

// Test-only hook: lets the SKRIVE_DIAG self-test drive the native channel
// directly (e.g. diag:poison for the 1.4 delivery-rule round-trip) without
// adding a contract method. Spike-only; the real bridge never exposes this.
(window as unknown as {
  __skriveNativeInvoke?: typeof nativeInvoke;
}).__skriveNativeInvoke = nativeInvoke;

// Surface the sample root for manual debugging in the web inspector.
(window as unknown as { __skriveSampleRoot?: string }).__skriveSampleRoot =
  SAMPLE_ROOT;
