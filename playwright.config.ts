import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env['FIXTURE_PORT'] ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0, // a flaky check is a bug; never hide it behind a retry
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node e2e/support/fixture-server.mjs ${port}`,
    url: `http://127.0.0.1:${port}/noop/basic.html`,
    reuseExistingServer: !process.env['CI'],
  },
});
