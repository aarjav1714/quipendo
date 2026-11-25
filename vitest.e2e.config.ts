import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.test.ts'],
    // Safari is driven one AppleScript at a time, which takes a while.
    testTimeout: process.env.E2E_BROWSER === 'safari' ? 300_000 : 120_000,
    hookTimeout: process.env.E2E_BROWSER === 'safari' ? 300_000 : 120_000,
    fileParallelism: false,
  },
});
