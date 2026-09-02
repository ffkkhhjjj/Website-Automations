import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Auth tests run against the dedicated throwaway DB created by global-setup.
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://lge:lge@127.0.0.1:5432/lge_auth_test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://lge:lge@127.0.0.1:5432/lge_auth_test',
      NODE_ENV: 'test',
    },
    // Tests hit a real Postgres; a single worker keeps pool usage and timing sane.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 20000,
  },
});