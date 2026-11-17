'use strict';
const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
// A fresh job-owned local server; strict test assertions remain enabled.
module.exports = defineConfig({
  testDir: path.join(root, 'tests/landing-e2e'),
  forbidOnly: true,
  retries: 0,
  workers: 2,
  timeout: 60000,
  expect: { timeout: 10000 },
  projects: [{ name: 'landing' }],
  reporter: [['list']],
  outputDir: path.join(root, 'test-results/landing'),
  use: {
    baseURL: 'http://127.0.0.1:3333',
    browserName: 'chromium',
    serviceWorkers: 'block',
    proxy: { server: 'http://127.0.0.1:3334', bypass: '127.0.0.1,localhost,[::1]' },
    trace: 'off', screenshot: 'off', video: 'off',
  },
  webServer: [
    { command: 'node scripts/ci-hosted/deny-egress.cjs', url: 'http://127.0.0.1:3334/healthz',
      cwd: root, reuseExistingServer: false, timeout: 10000 },
    { command: 'node scripts/frontend/serve-landing.js', url: 'http://127.0.0.1:3333',
      cwd: root, reuseExistingServer: false, timeout: 120000,
      env: { ENV_FILE: '/dev/null', ENV_FILE_APPEND: '0', ENV_FILE_OVERRIDE: '0',
        LANDING_HOST: '127.0.0.1', LANDING_PORT: '3333', LANDING_SITE_URL: 'http://127.0.0.1:3333',
        LANDING_APP_URL: 'https://app.example.com/login', LANDING_ENABLE_INTAKE_MOCKS: '1',
        LANDING_CONTACT_ENDPOINT: '/__landing-contact', LANDING_TENANT_SIGNUP_ENDPOINT: '/__tenant-signup',
        LANDING_TURNSTILE_SITE_KEY: '' } },
  ],
});
