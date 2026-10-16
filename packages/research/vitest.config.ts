import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    // Live-adapter tests hit the real network; run them serially.
    pool: 'forks',
  },
});
