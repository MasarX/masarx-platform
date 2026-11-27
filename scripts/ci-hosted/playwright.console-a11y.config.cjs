'use strict';
const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const hosted = require('./playwright.console-hosted.cjs');
// The CI step sets the evidence folder; its upload fails when the JSON report is missing.
if (!process.env.A11Y_EVIDENCE_DIR) throw new Error('A11Y_EVIDENCE_DIR is required');
const evidenceDir = path.resolve(root, process.env.A11Y_EVIDENCE_DIR);
// Console V2 axe suite against a job-owned seed-mode dev server; external network is denied.
module.exports = defineConfig({
  ...hosted,
  testDir: path.join(root, 'apps/console-v2/tests/a11y'),
  forbidOnly: true,
  retries: 0,
  workers: 2,
  timeout: 60000,
  expect: { timeout: 15000 },
  projects: [{ name: 'console-a11y' }],
  reporter: [['list'], ['json', { outputFile: path.join(evidenceDir, 'results.json') }]],
  outputDir: path.join(root, 'test-results/console-a11y'),
});
