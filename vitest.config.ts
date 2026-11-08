import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    dir: 'tests',
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
