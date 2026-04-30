// Web shim for @tauri-apps/api/window.
//
// The browser tab's lifecycle is owned by the user (close button, refresh,
// navigation away) and intercepting it would require beforeunload + a UA
// confirm prompt — undesirable for a demo where edits are explicitly
// ephemeral. The stub's `onCloseRequested` registers a no-op handler that
// will never fire; `destroy` is a no-op because the page can't close itself.

type UnlistenFn = () => void;

type CloseRequestedEvent = {
  preventDefault(): void;
};

export type Window = {
  onCloseRequested(
    handler: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn>;
  destroy(): Promise<void>;
};

const stubWindow: Window = {
  onCloseRequested(_handler) {
    return Promise.resolve(() => {});
  },
  destroy() {
    return Promise.resolve();
  },
};

export function getCurrentWindow(): Window {
  return stubWindow;
}
