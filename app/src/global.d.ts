import type { SkriveIpc } from '@skrive/shared';

declare global {
  interface Window {
    skrive: SkriveIpc;
    // Set to `true` by the Zig-shell web bridges (native-bridge.ts on macOS,
    // native-bridge-win.ts on Windows) to mark "this renderer is hosted by the
    // native shell." Electron loads neither bridge, so the flag is absent there.
    // Distinct from __SKRIVE_NATIVE_UPDATER__, which only tracks who owns the
    // updater UI (false on the macOS native shell). Use this — not the updater
    // flag — to ask "am I on the native app vs Electron?".
    __SKRIVE_NATIVE_SHELL__?: boolean;
  }
}
