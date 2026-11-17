const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  resolveManifestPath,
  resolveConfigPath,
  ensureDemoAccountsManifest,
} = require('../../../scripts/ops/ensure-demo-accounts-manifest');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

describe('ensure-demo-accounts-manifest', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('parseArgs accepts expected flags', () => {
    expect(parseArgs(['--out', 'tmp/x.json', '--config', 'config/demo/demo-accounts.json', '--force'])).toEqual({
      outPath: 'tmp/x.json',
      configPath: 'config/demo/demo-accounts.json',
      force: true,
    });
  });

  test('resolveManifestPath prefers explicit --out then DEMO_ACCOUNTS_PATH', () => {
    const cwd = '/repo';
    expect(
      resolveManifestPath({
        args: { outPath: 'tmp/a.json' },
        env: { DEMO_ACCOUNTS_PATH: 'tmp/b.json' },
        cwd,
      }),
    ).toBe(path.resolve(cwd, 'tmp', 'a.json'));

    expect(
      resolveManifestPath({
        args: { outPath: '' },
        env: { DEMO_ACCOUNTS_PATH: 'tmp/b.json' },
        cwd,
      }),
    ).toBe(path.resolve(cwd, 'tmp', 'b.json'));
  });

  test('resolveConfigPath defaults to config/demo/demo-accounts.json', () => {
    const cwd = '/repo';
    expect(resolveConfigPath({ args: { configPath: '' }, cwd })).toBe(
      path.resolve(cwd, 'config', 'demo', 'demo-accounts.json'),
    );
  });

  test('no-ops when manifest exists and is valid', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-demo-'));
    const manifestPath = path.join(tmp, 'tmp', 'demo-accounts.json');
    const configPath = path.join(tmp, 'cfg.json');

    writeJson(configPath, { ok: true });
    writeJson(manifestPath, { users: [{ email: 'a@example.com' }] });

    const spawnSyncImpl = jest.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const res = ensureDemoAccountsManifest({
      argv: ['--out', manifestPath, '--config', configPath],
      env: { STRICT_E2E_GATE_ENV: 'true' },
      cwd: tmp,
      spawnSyncImpl,
    });

    expect(res.ok).toBe(true);
    expect(res.action).toBe('exists');
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  test('fails in strict mode when manifest is missing and guard is disabled', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-demo-'));
    const manifestPath = path.join(tmp, 'tmp', 'demo-accounts.json');
    const configPath = path.join(tmp, 'cfg.json');
    writeJson(configPath, { ok: true });

    expect(() =>
      ensureDemoAccountsManifest({
        argv: ['--out', manifestPath, '--config', configPath],
        env: { STRICT_E2E_GATE_ENV: 'true' },
        cwd: tmp,
        spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
      }),
    ).toThrow(/DEMO_ACCOUNTS_PROVISION_GUARD/);
  });

  test('provisions when strict mode and guard enabled', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-demo-'));
    const manifestPath = path.join(tmp, 'tmp', 'demo-accounts.json');
    const configPath = path.join(tmp, 'cfg.json');
    writeJson(configPath, { ok: true });

    const spawnSyncImpl = jest.fn(() => {
      writeJson(manifestPath, { users: [{ email: 'a@example.com' }, { email: 'b@example.com' }] });
      return { status: 0, stdout: 'ok', stderr: '' };
    });

    const res = ensureDemoAccountsManifest({
      argv: ['--out', manifestPath, '--config', configPath],
      env: { STRICT_E2E_GATE_ENV: 'true', DEMO_ACCOUNTS_PROVISION_GUARD: 'enabled' },
      cwd: tmp,
      spawnSyncImpl,
    });

    expect(res.ok).toBe(true);
    expect(res.action).toBe('provisioned');
    expect(res.userCount).toBe(2);
    expect(spawnSyncImpl).toHaveBeenCalled();
  });

  test('provisions when strict mode and guard is true', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-demo-'));
    const manifestPath = path.join(tmp, 'tmp', 'demo-accounts.json');
    const configPath = path.join(tmp, 'cfg.json');
    writeJson(configPath, { ok: true });

    const spawnSyncImpl = jest.fn(() => {
      writeJson(manifestPath, { users: [{ email: 'a@example.com' }] });
      return { status: 0, stdout: 'ok', stderr: '' };
    });

    const res = ensureDemoAccountsManifest({
      argv: ['--out', manifestPath, '--config', configPath],
      env: { STRICT_E2E_GATE_ENV: 'true', DEMO_ACCOUNTS_PROVISION_GUARD: 'true' },
      cwd: tmp,
      spawnSyncImpl,
    });

    expect(res.ok).toBe(true);
    expect(res.action).toBe('provisioned');
    expect(res.userCount).toBe(1);
    expect(spawnSyncImpl).toHaveBeenCalled();
  });

  test('refuses to provision in production without allow flag', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-demo-'));
    const manifestPath = path.join(tmp, 'tmp', 'demo-accounts.json');
    const configPath = path.join(tmp, 'cfg.json');
    writeJson(configPath, { ok: true });

    expect(() =>
      ensureDemoAccountsManifest({
        argv: ['--out', manifestPath, '--config', configPath],
        env: {
          STRICT_E2E_GATE_ENV: 'true',
          DEMO_ACCOUNTS_PROVISION_GUARD: 'enabled',
          PROD_DEPLOY_GUARD: 'enabled',
        },
        cwd: tmp,
        spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
      }),
    ).toThrow(/Refusing to provision demo accounts in production/);
  });
});
