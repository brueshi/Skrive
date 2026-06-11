// The single command dispatcher (Stage 0.1 of the Zig shell plan).
//
// Every shell command registers here and every request flows through
// `dispatchJson`, regardless of transport. This module is deliberately
// Electron-free: the Electron wiring (the `skrive:invoke` handle, the
// window broadcast behind the event sink) lives in `main/index.ts`, so
// the dispatcher itself is unit-testable under plain vitest and is the
// same surface the parity-fixture harness drives.
//
// Envelope spec: `docs/Zig shell master plan.md` Part I; types and the
// closed error-code set in `shared/src/ipc-contracts.ts`.

import {
  ENVELOPE_VERSION,
  MAX_REQUEST_BYTES,
  type SkriveErrorCode,
  type SkriveEvent,
  type SkriveResponse
} from '@skrive/shared';

export type CommandPayload = Record<string, unknown>;
export type CommandResult = Record<string, unknown>;
export type CommandHandler = (
  payload: CommandPayload
) => CommandResult | Promise<CommandResult>;

/** A handler error that carries a contract error code. Anything else a
 *  handler throws maps to INTERNAL (with its message preserved). */
export class IpcError extends Error {
  readonly code: SkriveErrorCode;

  constructor(code: SkriveErrorCode, message: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

const registry = new Map<string, CommandHandler>();

export function registerCommand(cmd: string, handler: CommandHandler): void {
  if (registry.has(cmd)) {
    throw new Error(`Duplicate command registration: ${cmd}`);
  }
  registry.set(cmd, handler);
}

// ----------------------------- Events -----------------------------

type EventSink = (json: string) => void;

let eventSink: EventSink | null = null;

/** Install the transport's event delivery function. Events emitted
 *  before a sink is installed are dropped — same behavior as today's
 *  webContents.send to a not-yet-created window. */
export function setEventSink(sink: EventSink): void {
  eventSink = sink;
}

export function emitEvent(event: string, payload: CommandPayload): void {
  if (!eventSink) return;
  const envelope: SkriveEvent = { v: ENVELOPE_VERSION, event, payload };
  eventSink(JSON.stringify(envelope));
}

// ---------------------------- Dispatch ----------------------------

function errorResponse(
  id: number,
  code: SkriveErrorCode,
  message: string
): SkriveResponse {
  return { v: ENVELOPE_VERSION, id, ok: false, error: { code, message } };
}

const ENVELOPE_FIELDS = new Set(['v', 'id', 'cmd', 'payload']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate an envelope and run its handler. Never throws — every
 *  failure mode is an in-band error response. Invalid envelopes echo
 *  the request id when one is recoverable, else 0 (spec clarification
 *  documented in ipc-contracts.ts). */
export async function dispatch(envelope: unknown): Promise<SkriveResponse> {
  // Best-effort id for error responses on malformed envelopes.
  const rawId =
    isPlainObject(envelope) &&
    typeof envelope.id === 'number' &&
    Number.isInteger(envelope.id) &&
    envelope.id > 0
      ? envelope.id
      : 0;

  if (!isPlainObject(envelope)) {
    return errorResponse(0, 'BAD_ENVELOPE', 'Request is not a JSON object');
  }
  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_FIELDS.has(key)) {
      return errorResponse(
        rawId,
        'BAD_ENVELOPE',
        `Unknown top-level field: ${key}`
      );
    }
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    return errorResponse(
      rawId,
      'BAD_ENVELOPE',
      `Unsupported envelope version: ${String(envelope.v)}`
    );
  }
  if (rawId === 0) {
    return errorResponse(0, 'BAD_ENVELOPE', 'id must be a positive integer');
  }
  if (typeof envelope.cmd !== 'string' || envelope.cmd.length === 0) {
    return errorResponse(rawId, 'BAD_ENVELOPE', 'cmd must be a string');
  }
  if (!isPlainObject(envelope.payload)) {
    return errorResponse(rawId, 'BAD_ENVELOPE', 'payload must be an object');
  }

  const handler = registry.get(envelope.cmd);
  if (!handler) {
    return errorResponse(
      rawId,
      'UNKNOWN_COMMAND',
      `Unknown command: ${envelope.cmd}`
    );
  }

  try {
    const result = await handler(envelope.payload);
    return { v: ENVELOPE_VERSION, id: rawId, ok: true, result };
  } catch (err) {
    if (err instanceof IpcError) {
      return errorResponse(rawId, err.code, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(rawId, 'INTERNAL', message);
  }
}

/** The string-marshaled entry point every transport calls: size cap,
 *  parse, dispatch, serialize. Oversize requests are rejected before
 *  parsing, per spec. */
export async function dispatchJson(json: string): Promise<string> {
  let response: SkriveResponse;
  if (Buffer.byteLength(json, 'utf8') > MAX_REQUEST_BYTES) {
    response = errorResponse(
      0,
      'PAYLOAD_TOO_LARGE',
      `Request exceeds ${MAX_REQUEST_BYTES} bytes`
    );
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      parsed = undefined;
    }
    response =
      parsed === undefined
        ? errorResponse(0, 'BAD_ENVELOPE', 'Request is not valid JSON')
        : await dispatch(parsed);
  }
  return JSON.stringify(response);
}
