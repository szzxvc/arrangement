import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:8790',
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/browser-server.mjs',
    url: 'http://localhost:8790',
    reuseExistingServer: false,
    timeout: 60000,
  },
  reporter: [['list']],
});
