'use strict';
const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const hosted = require('./playwright.console-hosted.cjs');
const root = path.resolve(__dirname, '../..');

module.exports = defineConfig({
  ...hosted,
  testDir: path.join(root, 'apps/console-v2/tests/e2e'),
  grepInvert: /@live-readiness/,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 12000 },
  reporter: [['list']],
  outputDir: path.join(root, 'test-results/console-seed'),
});
