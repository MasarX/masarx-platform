jest.mock('../../../scripts/ops/workspace/local-console-runtime', () => ({
  DEFAULT_LOCAL_RUNTIME_HOST: '127.0.0.1',
  stopDetachedProcessGroup: jest.fn((pid, options = {}) => {
    options.processKillImpl(-pid, 'SIGTERM');
    return true;
  }),
  waitForConsoleListener: jest.fn(async () => ({ ok: false, reason: 'not_listening' })),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getLandingRuntimePaths,
  startLandingRuntime,
  stopLandingRuntime,
} = require('../../../scripts/ops/workspace/local-landing-runtime');

describe('workspace local Landing runtime', () => {
  test('builds the Landing site with the owned phase runtime URL', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-landing-runtime-'));
    const spawnImpl = jest.fn(() => ({
      pid: 4242,
      unref: jest.fn(),
    }));

    await startLandingRuntime({
      cwd,
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

  test('stops the detached POSIX process group even after its root exits', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-landing-stop-'));
    const paths = getLandingRuntimePaths(cwd, 3334);
    const processKillImpl = jest.fn();
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(paths.pidPath, '4242\n', 'utf8');
    const result = stopLandingRuntime({
      cwd, port: 3334, platform: 'linux', processKillImpl,
    });
    expect(result).toMatchObject({ ok: true, pid: 4242, killed: true });
    expect(processKillImpl).toHaveBeenCalledWith(-4242, 'SIGTERM');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
