// The Electron transport for the envelope contract. Requests are
// JSON-string envelopes on one channel, events arrive as JSON-string
// envelopes on another; `createSkriveBridge` maps the typed `SkriveIpc`
// surface onto this transport, so this file owns nothing but framing.
//
// Value imports come from the contract modules directly, NOT the
// `@skrive/shared` barrel. The barrel re-exports frontmatter helpers
// whose `yaml` import survives bundling as an external require — and a
// sandboxed preload can require nothing but `electron`, so that single
// line kills the preload before `window.skrive` is exposed. The
// contract modules (`ipc-contracts.ts`, `bridge.ts`) have zero runtime
// imports by design; keep them that way.

import { contextBridge, ipcRenderer } from 'electron';
import type {
  SkriveEvent,
  SkriveRequest,
  SkriveResponse
} from '../../../shared/src/ipc-contracts';
import {
  ENVELOPE_VERSION,
  SKRIVE_EVENT_CHANNEL,
  SKRIVE_INVOKE_CHANNEL
} from '../../../shared/src/ipc-contracts';
import {
  createSkriveBridge,
  type SkriveTransport
} from '../../../shared/src/bridge';

let nextRequestId = 1;

// One listener demuxes every shell event to its subscribers. Handlers
// are registered per event name; unsubscribe removes from the set.
type EventHandler = (payload: Record<string, unknown>) => void;
const eventHandlers = new Map<string, Set<EventHandler>>();

ipcRenderer.on(SKRIVE_EVENT_CHANNEL, (_event, raw: string) => {
  let envelope: SkriveEvent;
  try {
    envelope = JSON.parse(raw) as SkriveEvent;
  } catch {
    return;
  }
  const handlers = eventHandlers.get(envelope.event);
  if (!handlers) return;
  for (const handler of handlers) handler(envelope.payload);
});

const transport: SkriveTransport = {
  async invoke(cmd, payload) {
    const request: SkriveRequest = {
      v: ENVELOPE_VERSION,
      id: nextRequestId++,
      cmd,
      payload
    };
    const raw = (await ipcRenderer.invoke(
      SKRIVE_INVOKE_CHANNEL,
      JSON.stringify(request)
    )) as string;
    const response = JSON.parse(raw) as SkriveResponse;
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    return response.result;
  },
  on(event, handler) {
    let handlers = eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }
};

contextBridge.exposeInMainWorld('skrive', createSkriveBridge(transport));
