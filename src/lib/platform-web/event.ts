// Web shim for @tauri-apps/api/event.
//
// File-watcher and open-file events are emitted by the Rust core; on web
// neither source exists, so `listen` returns a no-op unsubscribe. Editor
// callers wire up listeners during onMount and tear them down on cleanup —
// returning a no-op preserves that lifecycle without needing to branch.

export type UnlistenFn = () => void;

export type Event<T> = {
  event: string;
  id: number;
  payload: T;
  windowLabel?: string;
};

export async function listen<T>(
  _event: string,
  _handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return () => {};
}
