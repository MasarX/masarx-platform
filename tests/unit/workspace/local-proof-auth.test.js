const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assertLocalSupabaseUrl,
  isRetryablePasswordGrantError,
  resolveManifestOperator,
  resolvePassword,
  resolveSessionAccessToken,
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
        data: { session: { access_token: 'header.payload.signature' } },
        error: null,
      });
    const signOut = jest.fn().mockResolvedValue({ error: null });
    const onAccessToken = jest.fn();

    const result = await verifyPasswordGrant({
      client: { auth: { signInWithPassword, signOut } },
      email: 'sipkxyzyxvgvtksowrxwjgpn@example.invalid',
      password: 'EXAMPLE_PASSWORD',
      env: {
        DEMO_ACCOUNTS_SIGN_IN_MAX_WAIT_MS: '50',
        DEMO_ACCOUNTS_SIGN_IN_RETRY_DELAY_MS: '1',
      },
      logger: { warn: jest.fn() },
      onAccessToken,
    });

    expect(result).toEqual({ attempts: 2, retried: true });
    expect(signInWithPassword).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(onAccessToken).toHaveBeenCalledWith('header.payload.signature');
    expect(JSON.stringify(result)).not.toContain('header.payload.signature');
  });

  test('fails closed before the access-token consumer when the password grant token is missing or invalid', async () => {
    const signOut = jest.fn().mockResolvedValue({ error: null });
    const onAccessToken = jest.fn();

    await expect(verifyPasswordGrant({
      client: {
        auth: {
          signInWithPassword: jest.fn().mockResolvedValue({
            data: { session: { access_token: '' } },
            error: null,
          }),
          signOut,
        },
      },
      email: 'sipkxyzyxvgvtksowrxwjgpn@example.invalid',
      password: 'EXAMPLE_PASSWORD',
      onAccessToken,
    })).rejects.toThrow('missing or invalid access token');

    expect(onAccessToken).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(() => resolveSessionAccessToken({ access_token: 'opaque-token' }))
      .toThrow('missing or invalid access token');
  });

  test('keeps session cleanup fail-safe when the in-memory access-token consumer fails', async () => {
    const signOut = jest.fn().mockResolvedValue({ error: null });
    await expect(verifyPasswordGrant({
      client: {
        auth: {
          signInWithPassword: jest.fn().mockResolvedValue({
            data: { session: { access_token: 'header.payload.signature' } },
            error: null,
          }),
          signOut,
        },
      },
      email: 'sipkxyzyxvgvtksowrxwjgpn@example.invalid',
      password: 'EXAMPLE_PASSWORD',
      onAccessToken: async () => { throw new Error('probe failed'); },
    })).rejects.toThrow('probe failed');
    expect(signOut).toHaveBeenCalledTimes(1);
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
      [
        path.join('scripts', 'ops', 'provision-demo-accounts.js'),
        '--out',
        path.join('tmp', 'demo-accounts.json'),
      ],
      expect.objectContaining({
        cwd,
        env: expect.objectContaining({
          DEMO_ACCOUNTS_PROVISION_GUARD: 'enabled',
          DEMO_PASSWORD: 'EXAMPLE_PASSWORD',
        }),
      }),
    );
    const childArgs = spawnSyncImpl.mock.calls[0][1];
    expect(childArgs).not.toContain('--password');
    expect(childArgs).not.toContain('EXAMPLE_PASSWORD');
  });
});
