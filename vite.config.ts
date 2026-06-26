import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Standalone renderer build, lifted out of electron.vite.config.ts's `renderer`
// block during the Electron removal. The Zig shell (macOS Swift + Windows Zig)
// is the only consumer: build-macos.sh / build-windows.sh copy out/renderer
// into the app bundle, so the output path is a contract and must stay
// `<repo>/out/renderer`. `bun run start:build` runs `vite build`; `bun run dev`
// runs the dev server the native hosts point at via SKRIVE_DEV_URL.
export default defineConfig({
  root: resolve(__dirname, 'app'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'app/index.html')
    }
  },
  resolve: {
    alias: {
      '@skrive/shared': resolve(__dirname, 'shared/src/index.ts'),
      '@app': resolve(__dirname, 'app/src'),
      // The lint engine runs in a Web Worker (Stage 2.75). Its markdown parser
      // (mdast-util-from-markdown -> micromark) pulls in
      // `decode-named-character-reference`, whose `browser` build calls
      // `document.createElement` at load — fatal in a Worker, which has no
      // `document`. Pin it to a shim mirroring the package's Node build.
      'decode-named-character-reference': resolve(
        __dirname,
        'app/src/lib/lint/decode-named-character-reference.node-shim.ts'
      )
    }
  },
  server: {
    // Native hosts hard-code SKRIVE_DEV_URL=http://localhost:5173, so the port
    // must be stable; fail loudly rather than silently hopping to 5174.
    port: 5173,
    strictPort: true
  }
});
