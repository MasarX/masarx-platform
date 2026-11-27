'use strict';

const { defineConfig } = require('@playwright/test');
const { join, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { loopback, ports, origin } = require('./preview-sweep-fixture.cjs');

const root = resolve(__dirname, '../..');
const { GITHUB_ACTIONS, GITHUB_EVENT_NAME, RUNNER_ENVIRONMENT, RUNNER_TEMP, SWEEP_LOCALE } = process.env;
if (GITHUB_ACTIONS !== 'true' || GITHUB_EVENT_NAME !== 'pull_request' ||
    RUNNER_ENVIRONMENT !== 'github-hosted' || !RUNNER_TEMP || !['en', 'ar'].includes(SWEEP_LOCALE)) {
  throw new Error('Preview sweep requires a GitHub-hosted pull request job');
}

const fixtureUrl = origin(ports.fixture);
const fixtureKey = randomBytes(24).toString('hex');
const nextEnv = {
  NEXT_PUBLIC_SUPABASE_URL: fixtureUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: fixtureKey,
  NEXT_PUBLIC_LOCALE: SWEEP_LOCALE,
  MASARX_RPC_RETRIES: '0',
};
const server = (command, port, env) => ({
  command, port, env, cwd: root, reuseExistingServer: false, timeout: 120_000,
  stdout: 'ignore', stderr: 'ignore',
});

module.exports = defineConfig({
  testDir: join(root, 'tests/preview-sweep'),
  repeatEach: 5,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'dot',
  outputDir: join(RUNNER_TEMP, 'preview-sweep-results'),
  use: {
    browserName: 'chromium', serviceWorkers: 'block',
    proxy: { server: origin(ports.proxy), bypass: loopback },
    trace: 'off', screenshot: 'off', video: 'off',
  },
  webServer: [
    server('node scripts/ci-hosted/deny-egress.cjs', ports.proxy),
    server('npm run dev --workspace @masarx/console -- --hostname ' + loopback, ports.console, nextEnv),
    {
      ...server(
        'npm run build --workspace @masarx/portal && npm run start --workspace @masarx/portal -- --hostname ' + loopback,
        ports.portal, nextEnv,
      ),
      timeout: 180_000,
      stdout: 'pipe', stderr: 'pipe',
    },
    server('npm run dev --workspace @masarx/console-v2 -- --host ' + loopback + ' --strictPort', ports['console-v2'], {
      VITE_SUPABASE_URL: fixtureUrl,
      VITE_SUPABASE_ANON_KEY: fixtureKey,
      VITE_USE_SEED: 'false',
    }),
  ],
});
