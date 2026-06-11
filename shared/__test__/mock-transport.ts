// In-memory SkriveTransport for testing the bridge factory — and the
// seed of the future web shim (the website embed grows this into a
// transport backed by an in-memory project instead of canned results).

import type { SkriveTransport } from '../src/bridge';

export type RecordedCall = {
  cmd: string;
  payload: Record<string, unknown>;
};

export class MockTransport implements SkriveTransport {
  /** Every invoke, in order — tests assert command names and payload
   *  shapes against this. */
  readonly calls: RecordedCall[] = [];

  private readonly results = new Map<string, Record<string, unknown>>();
  private readonly errors = new Map<string, Error>();
  private readonly handlers = new Map<
    string,
    Set<(payload: Record<string, unknown>) => void>
  >();

  /** Canned result for a command. The default for an un-stubbed command
   *  is `{}` — most void commands never need a stub. */
  stub(cmd: string, result: Record<string, unknown>): void {
    this.results.set(cmd, result);
  }

  /** Make a command reject, the way a real transport surfaces an error
   *  envelope. */
  stubError(cmd: string, message: string): void {
    this.errors.set(cmd, new Error(message));
  }

  /** Deliver a shell event to current subscribers. */
  emit(event: string, payload: Record<string, unknown>): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) handler(payload);
  }

  subscriberCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  async invoke(
    cmd: string,
    payload: Record<string, unknown>
  ): Promise<unknown> {
    this.calls.push({ cmd, payload });
    const error = this.errors.get(cmd);
    if (error) throw error;
    return this.results.get(cmd) ?? {};
  }

  on(
    event: string,
    handler: (payload: Record<string, unknown>) => void
  ): () => void {
    let handlers = this.handlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }
}
