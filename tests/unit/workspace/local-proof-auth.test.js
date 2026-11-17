const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assertLocalSupabaseUrl,
  isRetryablePasswordGrantError,
  resolveManifestOperator,
  resolvePassword,
  runProvisionDemoAccounts,
  verifyPasswordGrant,
} = require('../../../scripts/ops/workspace/local-proof-auth');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

describe('workspace local-proof-auth', () => {
  test('assertLocalSupabaseUrl accepts loopback and refuses non-local hosts', () => {
    expect(assertLocalSupabaseUrl('http://127.0.0.1:54321/')).toBe('http://127.0.0.1:54321');
    expect(assertLocalSupabaseUrl('http://localhost:54321')).toBe('http://localhost:54321');
    expect(() => assertLocalSupabaseUrl('https://example.supabase.co')).toThrow(/Refusing non-local/);
  });

  test('resolveManifestOperator chooses the ops admin from a manifest', () => {
    const operator = resolveManifestOperator({
      users: [
        { email: 'mlrznqhylvnirjwnhxhsjwgm@example.invalid', user_type: 'driver' },
        { email: 'jgnmgnoryzxuvgmhgkrumtur@example.invalid', user_type: 'ops_admin' },
      ],
    });

    expect(operator).toEqual({
      email: 'jgnmgnoryzxuvgmhgkrumtur@example.invalid',
      user_type: 'ops_admin',
    });
  });

  test('resolveManifestOperator fails closed when the manifest has no usable operator', () => {
    expect(() => resolveManifestOperator({ users: [] })).toThrow(/does not contain an operator account/);
    expect(() => resolveManifestOperator({
      users: [{ email: 'jgnmgnoryzxuvgmhgkrumtur@example.invalid', user_type: 'ops_admin' }],
    }, 'gwoikgitkqzzsgiorxyyvxut@example.invalid')).toThrow(/not present in the demo manifest/);
  });

  test('resolvePassword prefers explicit then env then manifest values', () => {
    expect(resolvePassword({
      args: { password: 'ExplicitPass123!' },
      env: { DEMO_PASSWORD: 'EnvPass123!' },
      manifest: { password: 'ManifestPass123!' },
    })).toBe('ExplicitPass123!');

    expect(resolvePassword({
      args: {},
      env: { DEMO_PASSWORD: 'EnvPass123!' },
      manifest: { password: 'ManifestPass123!' },
    })).toBe('EnvPass123!');

    expect(resolvePassword({
      args: {},
      env: {},
      manifest: { password: 'ManifestPass123!' },
    })).toBe('ManifestPass123!');
  });

  test('classifies local password grant propagation failures as retryable', () => {
    expect(isRetryablePasswordGrantError({
      message: 'Invalid login credentials',
      code: 'invalid_credentials',
      status: 400,
    })).toBe(true);
    expect(isRetryablePasswordGrantError({ message: 'temporarily unavailable', status: 503 })).toBe(true);
    expect(isRetryablePasswordGrantError({ message: 'email not confirmed', status: 400 })).toBe(false);
  });

  test('verifyPasswordGrant retries until a Supabase session exists', async () => {
    const signInWithPassword = jest
      .fn()
      .mockResolvedValueOnce({
        data: { session: null },
        error: {
          message: 'Invalid login credentials',
          code: 'invalid_credentials',
          status: 400,
        },
      })
      .mockResolvedValueOnce({
        data: { session: { access_token: 'token' } },
        error: null,
      });
    const signOut = jest.fn().mockResolvedValue({ error: null });

    const result = await verifyPasswordGrant({
      client: { auth: { signInWithPassword, signOut } },
      email: 'sipkxyzyxvgvtksowrxwjgpn@example.invalid',
      password: 'EXAMPLE_PASSWORD',
      env: {
        DEMO_ACCOUNTS_SIGN_IN_MAX_WAIT_MS: '50',
        DEMO_ACCOUNTS_SIGN_IN_RETRY_DELAY_MS: '1',
      },
      logger: { warn: jest.fn() },
    });

    expect(result).toEqual({ attempts: 2, retried: true });
    expect(signInWithPassword).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  test('runProvisionDemoAccounts invokes the guarded local demo bootstrap with a relative manifest path', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-proof-auth-'));
    const manifestPath = path.join(cwd, 'tmp', 'demo-accounts.json');
    writeJson(manifestPath, { users: [] });

    const spawnSyncImpl = jest.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const result = runProvisionDemoAccounts({
      manifestPath,
      password: 'EXAMPLE_PASSWORD',
      env: { ENV_FILE: path.join('config', 'env', '.env.local') },
      spawnSyncImpl,
      cwd,
    });

    expect(result).toEqual({
      code: 0,
      manifestRel: path.join('tmp', 'demo-accounts.json'),
    });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      process.execPath || 'node',
      expect.arrayContaining([
        path.join('scripts', 'ops', 'provision-demo-accounts.js'),
        '--out',
        path.join('tmp', 'demo-accounts.json'),
        '--password',
        'EXAMPLE_PASSWORD',
      ]),
      expect.objectContaining({
        cwd,
        env: expect.objectContaining({
          DEMO_ACCOUNTS_PROVISION_GUARD: 'enabled',
          DEMO_PASSWORD: 'EXAMPLE_PASSWORD',
        }),
      }),
    );
  });
});
