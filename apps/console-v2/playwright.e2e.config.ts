import { defineConfig, devices } from '@playwright/test';

// E2E happy-path config — Phase G / G4.
//
// Purpose
//   Drives 10 most-common operator user-stories against the live console-v2
//   dev server, asserting (a) capability gates fire, (b) the canonical RPC
//   name surfaces in the success toast, and (c) the post-success DOM state
//   is observable.
//
// How it runs (mock-mode default)
//   - The console-v2 dev server runs in mock mode by default (no
//     VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY exported), so the data-source
//     adapter routes every RPC through the in-memory seed catalog. That means
//     the suite needs no backend, no preview workspace, and no auth seam.
//   - Tests assert the RPC name via the success toast text — every mutation
//     in the codebase pushes a toast like "reserve_delivery_slot_v1 · …" so
//     we get a name-level RPC fingerprint without hooking the network.
//
// Configuring base URL
//   Mirrors the a11y/visual configs: VERIFY_BASE selects the dev-server URL,
//   defaulting to http://localhost:5175. Override per-shell when running on a
//   non-default port (e.g. when a sibling worktree already holds 5175):
//     VERIFY_BASE=http://localhost:5180 npm run test:e2e:console
//
// Local seed-smoke run (not production-readiness proof)
//   1. cd apps/console-v2
//   2. npm run dev -- --port 5180 --strictPort   (in another shell)
//   3. VERIFY_BASE=http://localhost:5180 npm run test:e2e:console
//
// Live readiness proof
//   Run npm run test:e2e:console:live only against VITE_USE_SEED=false with
//   E2E_CONSOLE_LIVE=1, real Supabase env, and live auth credentials.
//   For local backend-backed debugging, prefer:
//     npm run test:e2e:console:live:local -- --grep "Story 02" --project=chromium
//   The local helper loads .env.local, enables live mode, and selects the
//   local auth manifest when present. It is supporting proof only; Browser or
//   Chrome live clicked proof is still required before marking readiness.

export default defineConfig({
  testDir: './tests/e2e',
  // Higher timeout than a11y because some stories navigate through 3-4
  // surfaces (open drawer -> open modal -> submit -> assert toast) before
  // they assert. 45 s is conservative for mock-mode.
  // Tests are deliberately serialized (workers: 1). Total budget is 60s per
  // test with 12s default `expect()` timeout — generous enough to absorb
  // Vite-dev-mode HMR variance between tests when the suite runs in sequence
  // (modules get re-bundled between tests, so first-paint times drift).
  timeout: 60_000,
  expect: { timeout: 12_000 },
  // Keep the suite serial; mock-mode state is shared per dev-server process
  // and module-level seed mutations (e.g. start_workflow_run synthetic ids)
  // would flake if multiple workers raced.
  workers: 1,
  fullyParallel: false,
  // One retry per story absorbs the residual Vite-HMR jitter (cold-load
  // first-paint variance, drawer-transition micro-delays). The first run is
  // what we observe locally; CI parity stays predictable because every retry
  // is also gated by the same per-test timeout budget.
  retries: 1,
  // Single project — Chromium desktop. The shell layout is responsive, but
  // the happy-path stories are mouse-first and Desktop Chrome is the canonical
  // target. Fewer projects = lower flake budget for the happy-path gate.
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-e2e' }]],
  use: {
    baseURL: process.env.VERIFY_BASE || 'http://localhost:5175',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
