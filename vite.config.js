import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const isWebTarget = process.env.VITE_TARGET === "web";
// @ts-expect-error process is a nodejs global
const projectRoot = process.cwd();

// When VITE_TARGET=web, redirect every @tauri-apps/* import to the matching
// shim under src/lib/platform-web/. The Tauri build (default target) leaves
// the alias array empty so Vite's resolver is unchanged — the shim files
// stay outside the Tauri import graph.
/** @param {string} name */
const shim = (name) => `${projectRoot}/src/lib/platform-web/${name}.ts`;
const webShimAliases = isWebTarget
  ? [
      { find: "@tauri-apps/api/core", replacement: shim("core") },
      { find: "@tauri-apps/api/event", replacement: shim("event") },
      { find: "@tauri-apps/api/webview", replacement: shim("webview") },
      { find: "@tauri-apps/api/window", replacement: shim("window") },
      { find: "@tauri-apps/api/path", replacement: shim("path") },
      { find: "@tauri-apps/plugin-dialog", replacement: shim("plugin-dialog") },
      { find: "@tauri-apps/plugin-opener", replacement: shim("plugin-opener") },
      { find: "@tauri-apps/plugin-updater", replacement: shim("plugin-updater") },
      { find: "@tauri-apps/plugin-process", replacement: shim("plugin-process") },
    ]
  : [];

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],

  resolve: {
    alias: webShimAliases,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
