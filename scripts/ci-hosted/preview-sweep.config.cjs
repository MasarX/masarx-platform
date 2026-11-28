'use strict';

const { defineConfig } = require('@playwright/test');
const { join, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { loopback, ports, origin } = require('./preview-sweep-fixture.cjs');

const root = resolve(__dirname, '../..');
const { GITHUB_ACTIONS, GITHUB_EVENT_NAME, RUNNER_ENVIRONMENT, RUNNER_TEMP, SWEEP_LOCALE } = process.env;
const consoleJourneys = process.env.SWEEP_CONSOLE_JOURNEYS === '1';
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
const consoleServer = server('npm run dev --workspace @masarx/console -- --hostname ' + loopback, ports.console, nextEnv);
const credentialsFile = join(RUNNER_TEMP, 'console-journey-credentials.json');
const journeyViewports = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
if (consoleJourneys) {
  process.env.E2E_SWEEP_CREDENTIALS_FILE = credentialsFile;
  process.env.CONSOLE_BASE_URL = origin(ports.console);
  process.env.E2E_STRICT_ALLOW_EXPLICIT_LOCALHOST = '1';
}

module.exports = defineConfig({
  testDir: join(root, consoleJourneys ? 'tests/e2e' : 'tests/preview-sweep'),
  ...(consoleJourneys && {
    testMatch: ['**/console-signed-in-coverage.spec.ts', '**/console-pickup-batch2.spec.ts'],
    projects: Object.entries(journeyViewports).flatMap(([size, viewport]) =>
      ['light', 'dark'].map(colorScheme => ({
        name: `${size}-${colorScheme}`, use: { viewport, colorScheme, hasTouch: size === 'phone' },
      }))),
  }),
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'dot',
  outputDir: join(RUNNER_TEMP, consoleJourneys ? 'console-journey-results' : 'preview-sweep-results'),
  use: {
    browserName: 'chromium', serviceWorkers: 'block',
    proxy: { server: origin(ports.proxy), bypass: loopback },
    trace: 'off', screenshot: 'off', video: 'off',
  },
  webServer: [
    server('node scripts/ci-hosted/deny-egress.cjs', ports.proxy),
    ...(consoleJourneys ? [
      server('node scripts/ci-hosted/preview-sweep-fixture.cjs', ports.fixture, {
        E2E_SWEEP_CREDENTIALS_FILE: credentialsFile,
      }),
      consoleServer,
    ] : [
      consoleServer,
      server('npm run dev --workspace @masarx/portal -- --hostname ' + loopback, ports.portal, nextEnv),
      server('npm run dev --workspace @masarx/console-v2 -- --host ' + loopback + ' --strictPort', ports['console-v2'], {
        VITE_SUPABASE_URL: fixtureUrl,
        VITE_SUPABASE_ANON_KEY: fixtureKey,
        VITE_USE_SEED: 'false',
      }),
    ]),
  ],
});
