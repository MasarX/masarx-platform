jest.mock('../../../scripts/ops/workspace/local-console-runtime', () => ({
  waitForConsoleListener: jest.fn(async () => ({ ok: false, reason: 'not_listening' })),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { startLandingRuntime } = require('../../../scripts/ops/workspace/local-landing-runtime');

describe('workspace local Landing runtime', () => {
  test('builds the Landing site with the owned phase runtime URL', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-landing-runtime-'));
    const spawnImpl = jest.fn(() => ({
      pid: 4242,
      unref: jest.fn(),
    }));

    await startLandingRuntime({
      cwd,
      host: '127.0.0.1',
      port: 3334,
      spawnImpl,
      reuseProbeTimeoutMs: 1,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [, , options] = spawnImpl.mock.calls[0];
    expect(options.env.LANDING_HOST).toBe('127.0.0.1');
    expect(options.env.LANDING_PORT).toBe('3334');
    expect(options.env.LANDING_SITE_URL).toBe('http://127.0.0.1:3334');
  });
});
