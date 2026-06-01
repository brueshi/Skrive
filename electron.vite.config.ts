import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['@skrive/diff'] })],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'shell/src/main/index.ts') }
    },
    resolve: {
      alias: {
        '@skrive/shared': resolve(__dirname, 'shared/src/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'shell/src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs'
      }
    },
    resolve: {
      alias: {
        '@skrive/shared': resolve(__dirname, 'shared/src/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'app'),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'app/index.html')
      }
    },
    resolve: {
      alias: {
        '@skrive/shared': resolve(__dirname, 'shared/src/index.ts'),
        '@app': resolve(__dirname, 'app/src'),
        // The lint engine runs in a Web Worker (Stage 2.75). Its markdown
        // parser (mdast-util-from-markdown → micromark) pulls in
        // `decode-named-character-reference`, whose `browser` build calls
        // `document.createElement` at load — fatal in a Worker, which has no
        // `document`. Pin it to a shim mirroring the package's Node build (a
        // pure character-entities lookup); see the shim for the full rationale.
        'decode-named-character-reference': resolve(
          __dirname,
          'app/src/lib/lint/decode-named-character-reference.node-shim.ts'
        )
      }
    }
  }
});
