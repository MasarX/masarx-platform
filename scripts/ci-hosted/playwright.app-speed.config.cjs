'use strict';
const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const root = path.resolve(__dirname, '../..');
const app = process.env.SPEED_APP;
if (app !== 'console-v2' && app !== 'portal') throw new Error('SPEED_APP must select console-v2 or portal');

const local = port => `http://127.0.0.1:${port}`;
const portal = app === 'portal';
const port = portal ? 3002 : 5175;
const webServer = [
  { command: 'node scripts/ci-hosted/deny-egress.cjs', url: `${local(3334)}/healthz` },
  { command: portal
    ? 'npm --prefix apps/portal run start -- --hostname 127.0.0.1'
    : 'npm --prefix apps/console-v2 run preview -- --host 127.0.0.1 --strictPort',
    url: portal ? local(port) + '/tracking' : local(port),
    env: { MASARX_RPC_RETRIES: '0' },
  },
];
if (portal) {
  webServer.splice(1, 0, {
    command: 'node scripts/ci-hosted/portal-speed-backend.cjs',
    url: `${local(54321)}/healthz`,
  });
}

module.exports = defineConfig({
  testDir: path.join(root, 'tests/speed-e2e'),
  testMatch: `**/${app}-speed-p75.spec.ts`,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60000,
  reporter: 'list',
  outputDir: path.join(root, 'test-results', app + '-speed'),
  use: {
    baseURL: local(port),
    browserName: 'chromium',
    proxy: { server: local(3334), bypass: '127.0.0.1,localhost,[::1]' },
  },
  webServer: webServer.map(server => ({
    ...server, cwd: root, reuseExistingServer: false, timeout: 30000,
  })),
});
