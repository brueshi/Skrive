// Envelope dispatcher tests (Stage 0.1 acceptance). The dispatcher is
// Electron-free, so these run under plain vitest — the same property
// that lets the parity-fixture harness drive it later.

import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_VERSION,
  MAX_REQUEST_BYTES,
  type SkriveResponse
} from '@skrive/shared';
import {
  IpcError,
  dispatch,
  dispatchJson,
  emitEvent,
  registerCommand,
  setEventSink
} from '../src/main/dispatch';

function request(
  cmd: string,
  payload: Record<string, unknown> = {},
  id = 1
): string {
  return JSON.stringify({ v: ENVELOPE_VERSION, id, cmd, payload });
}

async function roundTrip(json: string): Promise<SkriveResponse> {
  return JSON.parse(await dispatchJson(json)) as SkriveResponse;
}

function expectError(
  response: SkriveResponse,
  code: string
): asserts response is SkriveResponse & { ok: false } {
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe(code);
    expect(typeof response.error.message).toBe('string');
  }
}

// Registered once at module scope — the registry is module-global and
// rejects duplicate registration by design.
registerCommand('test:echo', (payload) => ({ echoed: payload }));
registerCommand('test:throwPlain', () => {
  throw new Error('plain failure');
});
registerCommand('test:throwCoded', () => {
  throw new IpcError('PATH_ESCAPE', 'Path escapes project root: ../x');
});

describe('dispatch', () => {
  it('round-trips a registered command', async () => {
    const response = await roundTrip(request('test:echo', { a: 1 }, 42));
    expect(response).toEqual({
      v: ENVELOPE_VERSION,
      id: 42,
      ok: true,
      result: { echoed: { a: 1 } }
    });
  });

  it('rejects an unknown command with UNKNOWN_COMMAND', async () => {
    const response = await roundTrip(request('nope:never', {}, 7));
    expectError(response, 'UNKNOWN_COMMAND');
    expect(response.id).toBe(7);
  });

  it('rejects an oversize request with PAYLOAD_TOO_LARGE without parsing', async () => {
    const oversize = '{"pad":"' + 'a'.repeat(MAX_REQUEST_BYTES) + '"}';
    const response = JSON.parse(await dispatchJson(oversize)) as SkriveResponse;
    expectError(response, 'PAYLOAD_TOO_LARGE');
    expect(response.id).toBe(0);
  });

  it('rejects malformed JSON with BAD_ENVELOPE and id 0', async () => {
    const response = await roundTrip('{not json');
    expectError(response, 'BAD_ENVELOPE');
    expect(response.id).toBe(0);
  });

  it('rejects a non-object envelope', async () => {
    expectError(await roundTrip('"hello"'), 'BAD_ENVELOPE');
    expectError(await roundTrip('[1,2]'), 'BAD_ENVELOPE');
    expectError(await roundTrip('null'), 'BAD_ENVELOPE');
  });

  it('rejects unknown top-level fields', async () => {
    const response = await roundTrip(
      JSON.stringify({ v: 1, id: 3, cmd: 'test:echo', payload: {}, extra: 1 })
    );
    expectError(response, 'BAD_ENVELOPE');
    expect(response.id).toBe(3);
  });

  it('rejects a wrong envelope version', async () => {
    const response = await roundTrip(
      JSON.stringify({ v: 2, id: 4, cmd: 'test:echo', payload: {} })
    );
    expectError(response, 'BAD_ENVELOPE');
  });

  it('rejects non-positive and non-integer ids with id 0 in the response', async () => {
    for (const id of [0, -1, 1.5, '1', null, undefined]) {
      const response = await roundTrip(
        JSON.stringify({ v: 1, id, cmd: 'test:echo', payload: {} })
      );
      expectError(response, 'BAD_ENVELOPE');
      expect(response.id).toBe(0);
    }
  });

  it('rejects a non-object payload', async () => {
    const response = await roundTrip(
      JSON.stringify({ v: 1, id: 5, cmd: 'test:echo', payload: 'scalar' })
    );
    expectError(response, 'BAD_ENVELOPE');
  });

  it('maps a plain handler throw to INTERNAL with the message preserved', async () => {
    const response = await roundTrip(request('test:throwPlain'));
    expectError(response, 'INTERNAL');
    if (!response.ok) expect(response.error.message).toBe('plain failure');
  });

  it('preserves IpcError codes from handlers', async () => {
    const response = await roundTrip(request('test:throwCoded'));
    expectError(response, 'PATH_ESCAPE');
  });

  it('rejects duplicate command registration', () => {
    expect(() => registerCommand('test:echo', () => ({}))).toThrow(
      /Duplicate command registration/
    );
  });

  it('dispatch() validates non-JSON-borne envelopes too', async () => {
    const response = await dispatch({
      v: ENVELOPE_VERSION,
      id: 9,
      cmd: 'test:echo',
      payload: {}
    });
    expect(response.ok).toBe(true);
    expect(response.id).toBe(9);
  });
});

describe('events', () => {
  it('serializes events through the sink as envelopes', () => {
    const seen: string[] = [];
    setEventSink((json) => seen.push(json));
    emitEvent('project:change', { kind: 'change', path: 'notes/a.md' });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!)).toEqual({
      v: ENVELOPE_VERSION,
      event: 'project:change',
      payload: { kind: 'change', path: 'notes/a.md' }
    });
  });
});
