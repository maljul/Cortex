import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/env.setup.ts'],
    // These tests talk to a real CockroachDB cluster over the network and
    // deliberately serialise two transactions against each other.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Files share one probe table; never run them against each other.
    fileParallelism: false,
  },
});
