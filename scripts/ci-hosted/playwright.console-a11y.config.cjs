'use strict';
const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
// Console V2 axe suite against a job-owned seed-mode dev server; external network is denied.
module.exports = defineConfig({
  testDir: path.join(root, 'apps/console-v2/tests/a11y'),
  forbidOnly: true,
  retries: 0,
  workers: 2,
  timeout: 60000,
  expect: { timeout: 15000 },
  projects: [{ name: 'console-a11y' }],
  reporter: [['list']],
  outputDir: path.join(root, 'test-results/console-a11y'),
  use: {
    baseURL: 'http://127.0.0.1:5175',
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    proxy: { server: 'http://127.0.0.1:3334', bypass: '127.0.0.1,localhost,[::1]' },
    navigationTimeout: 45000,
    actionTimeout: 15000,
    trace: 'off', screenshot: 'off', video: 'off',
  },
  webServer: [
    { command: 'node scripts/ci-hosted/deny-egress.cjs', url: 'http://127.0.0.1:3334/healthz',
      cwd: root, reuseExistingServer: false, timeout: 10000 },
    { command: 'npm run dev -- --host 127.0.0.1 --strictPort', url: 'http://127.0.0.1:5175',
      cwd: path.join(root, 'apps/console-v2'), reuseExistingServer: false, timeout: 120000,
      // Unset Supabase settings plus seed mode keep every screen on synthetic seed data.
      env: { VITE_USE_SEED: 'true', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' } },
  ],
});
