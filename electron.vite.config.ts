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
        '@app': resolve(__dirname, 'app/src')
      }
    }
  }
});
