import { defineConfig, devices } from '@playwright/test';

// W14-10 — per-test budget bumped from 30s -> 60s to absorb cold-start Vite
// dependency optimization on contended runners (multi-agent worktrees share
// the same machine, so first-compile of late-suite routes such as
// Workflow Binding Dispatches / Platform Alerts / Insights API Gateway /
// Platform Users can spike past 30s when ports 5175-5180 are saturated by
// sibling Wave 14 agents). Warm-server runs still finish in 3-9s, so the
// new budget only matters during cold-start contention.
export default defineConfig({
  testDir: './tests/a11y',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-a11y' }]],
  use: {
    baseURL: process.env.VERIFY_BASE || 'http://localhost:5175',
    trace: 'on-first-retry',
    viewport: { width: 1440, height: 900 },
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
