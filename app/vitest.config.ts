import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['__test__/**/*.test.ts', '__test__/**/*.test.tsx'],
    root: __dirname
  },
  resolve: {
    alias: {
      '@skrive/shared': resolve(__dirname, '../shared/src/index.ts')
    }
  }
});
