import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: {
      '@erp/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
      '@erp/db': new URL('../../packages/db/src/index.ts', import.meta.url).pathname,
    },
  },
});
