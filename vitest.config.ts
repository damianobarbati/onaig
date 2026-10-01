import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watch: process.env.HEADLESS === 'false',
    testTimeout: 60_000,
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    sequence: { shuffle: { files: true } },
    chaiConfig: { truncateThreshold: process.env.CI ? 40 : 0 },
    restoreMocks: true,
  },
});
