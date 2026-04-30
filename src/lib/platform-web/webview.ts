// Web shim for @tauri-apps/api/webview.
//
// The desktop app uses `getCurrentWebview().onDragDropEvent` to receive
// file drops with absolute filesystem paths — a Tauri-specific channel.
// Browsers can deliver drops too but only as `File` objects, not paths,
// so the shim returns a webview stub whose drag-drop subscription never
// fires. Real web drag-drop support (object-URL roundtrip) is a planned
// follow-up.

type UnlistenFn = () => void;

type DragDropEvent =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

export type Webview = {
  onDragDropEvent(
    handler: (event: { payload: DragDropEvent }) => void,
  ): Promise<UnlistenFn>;
};

const stubWebview: Webview = {
  onDragDropEvent(_handler) {
    return Promise.resolve(() => {});
  },
};

export function getCurrentWebview(): Webview {
  return stubWebview;
}
