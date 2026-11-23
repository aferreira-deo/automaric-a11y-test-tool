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
  projects: [
    { name: 'chromium', testIgnore: 'extension/**', use: { ...devices['Desktop Chrome'] } },
    // The unpacked extension in a Chromium of its own per worker (e2e/support/extension.ts): the
    // tests launch it themselves, since an extension needs a persistent context.
    // Each of its workers runs a full Chromium, and some of its tests scan one page twice. It gets
    // two of the workers, so that the tests of the other project that start browsers of their own
    // (the CLI) keep the time they had: one of them needs 27 of its 30 seconds as it is.
    { name: 'extension', testMatch: 'extension/**/*.spec.ts', workers: 2 },
  ],
  webServer: {
    command: `node e2e/support/fixture-server.mjs ${port}`,
    url: `http://127.0.0.1:${port}/noop/basic.html`,
    reuseExistingServer: !process.env['CI'],
  },
});
