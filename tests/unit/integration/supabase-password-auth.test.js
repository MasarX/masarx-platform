const {
  isRetryablePasswordGrantError,
  resolvePasswordGrantRetryConfig,
  signInWithPasswordWithRetry,
} = require('../../../tests/integration/helpers/supabase-password-auth');

describe('supabase-password-auth helper', () => {
  test('classifies preview auth propagation errors as retryable', () => {
    expect(isRetryablePasswordGrantError({
      message: 'Invalid login credentials',
      code: 'invalid_credentials',
      status: 400,
    })).toBe(true);
    expect(isRetryablePasswordGrantError({
      message: 'Tenant or user not found',
    })).toBe(true);
    expect(isRetryablePasswordGrantError({
      message: 'temporarily unavailable',
      status: 503,
    })).toBe(true);
    expect(isRetryablePasswordGrantError({
      message: 'email not confirmed',
      status: 400,
    })).toBe(false);
  });

  test('inherits retry config from the demo-accounts auth probe contract', () => {
    expect(resolvePasswordGrantRetryConfig({
      DEMO_ACCOUNTS_ADMIN_PROBE_MAX_WAIT_MS: '5000',
      DEMO_ACCOUNTS_ADMIN_PROBE_RETRY_DELAY_MS: '250',
    })).toEqual({
      maxWaitMs: 5000,
      retryDelayMs: 250,
    });

    expect(resolvePasswordGrantRetryConfig({
      DEMO_ACCOUNTS_SIGN_IN_MAX_WAIT_MS: '7000',
      DEMO_ACCOUNTS_SIGN_IN_RETRY_DELAY_MS: '300',
      DEMO_ACCOUNTS_ADMIN_PROBE_MAX_WAIT_MS: '5000',
      DEMO_ACCOUNTS_ADMIN_PROBE_RETRY_DELAY_MS: '250',
    })).toEqual({
      maxWaitMs: 7000,
      retryDelayMs: 300,
    });
  });

  test('retries password sign-in until the session becomes available', async () => {
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

    const result = await signInWithPasswordWithRetry({
      client: { auth: { signInWithPassword, signOut } },
      email: 'mlrznqhylvnirjwnhxhsjwgm@example.invalid',
      password: 'EXAMPLE_PASSWORD',
      env: {
        DEMO_ACCOUNTS_SIGN_IN_MAX_WAIT_MS: '50',
        DEMO_ACCOUNTS_SIGN_IN_RETRY_DELAY_MS: '1',
      },
      logger: { warn: jest.fn() },
    });

    expect(result.data.session.access_token).toBe('token');
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    expect(signInWithPassword).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test('fails fast for non-retryable password sign-in errors', async () => {
    const error = {
      message: 'email not confirmed',
      status: 400,
    };
    const signInWithPassword = jest.fn().mockResolvedValue({
      data: { session: null },
      error,
    });
    const signOut = jest.fn();

    await expect(signInWithPasswordWithRetry({
      client: { auth: { signInWithPassword, signOut } },
      email: 'mlrznqhylvnirjwnhxhsjwgm@example.invalid',
      password: 'EXAMPLE_PASSWORD',
      env: {
        DEMO_ACCOUNTS_SIGN_IN_MAX_WAIT_MS: '50',
        DEMO_ACCOUNTS_SIGN_IN_RETRY_DELAY_MS: '1',
      },
      logger: { warn: jest.fn() },
    })).rejects.toBe(error);

    expect(signInWithPassword).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });
});
