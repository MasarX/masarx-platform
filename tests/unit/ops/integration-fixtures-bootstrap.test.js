const {
  buildFixtureProfile,
  isRetryableFixtureBootstrapConcurrencyError,
  isRetryableFixtureBootstrapError,
  resolveDatabaseUrl,
  resolveFixtureBootstrapRetryConfig,
  withFixtureBootstrapRetry,
} = require('../../../scripts/tests/bootstrap/lib/integration-fixtures');

describe('integration fixture bootstrap helpers', () => {
  test('buildFixtureProfile normalizes prefix and emits expected fixture keys', () => {
    const profile = buildFixtureProfile({ INTEGRATION_FIXTURE_PREFIX: 'Test_Profile' });
    expect(profile.prefix).toBe('test_profile');
    expect(profile.organizations.alpha.slug).toBe('test_profile-org-alpha');
    expect(profile.clients.twoOne.slug).toBe('test_profile-client-2-1');
    expect(profile.webhook.basic.token).toBe('EXAMPLE_PASSWORD');
  });

  test('resolveDatabaseUrl resolves DSN from env ladder', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://a' })).toBe('postgres://a');
    expect(resolveDatabaseUrl({ DATABASE_URL_DIRECT: 'postgres://b' })).toBe('postgres://b');
    expect(resolveDatabaseUrl({ DATABASE_URL_POOLER: 'postgres://c' })).toBe('postgres://c');
  });

  test('resolveDatabaseUrl throws when no database DSN is present', () => {
    expect(() => resolveDatabaseUrl({})).toThrow('DATABASE_URL');
  });

  test('resolveFixtureBootstrapRetryConfig reads env-driven retry knobs', () => {
    expect(
      resolveFixtureBootstrapRetryConfig({
        PGTAP_FIXTURE_BOOTSTRAP_MAX_WAIT_MS: '90000',
        PGTAP_FIXTURE_BOOTSTRAP_RETRY_DELAY_MS: '1500',
        PGTAP_FIXTURE_BOOTSTRAP_CONNECT_TIMEOUT_MS: '7000',
      }),
    ).toEqual({
      maxWaitMs: 90000,
      retryDelayMs: 1500,
      connectionTimeoutMs: 7000,
    });
  });

  test('isRetryableFixtureBootstrapError treats transient preview db failures as retryable', () => {
    expect(
      isRetryableFixtureBootstrapError({
        code: 'XX000',
        message: 'DbHandler exited. Check logs for more information.',
      }),
    ).toBe(true);
    expect(isRetryableFixtureBootstrapError(new Error('Tenant or user not found'))).toBe(true);
    expect(isRetryableFixtureBootstrapError(new Error('syntax error at or near select'))).toBe(false);
  });

  test('isRetryableFixtureBootstrapConcurrencyError treats deadlocks and serialization conflicts as retryable', () => {
    expect(
      isRetryableFixtureBootstrapConcurrencyError({
        code: '40P01',
        message: 'deadlock detected',
      }),
    ).toBe(true);
    expect(
      isRetryableFixtureBootstrapConcurrencyError({
        code: '40001',
        message: 'could not serialize access due to concurrent update',
      }),
    ).toBe(true);
    expect(
      isRetryableFixtureBootstrapConcurrencyError({
        code: '55P03',
        message: 'lock not available',
      }),
    ).toBe(true);
    expect(
      isRetryableFixtureBootstrapConcurrencyError({
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      }),
    ).toBe(false);
  });

  test('withFixtureBootstrapRetry retries transient fixture bootstrap failures', async () => {
    const sleepCalls = [];
    let fakeNow = 0;
    let attempts = 0;

    const result = await withFixtureBootstrapRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error('DbHandler exited. Check logs for more information.'), {
            code: 'XX000',
          });
        }
        return 'ok';
      },
      {
        env: {
          PGTAP_FIXTURE_BOOTSTRAP_MAX_WAIT_MS: '10000',
          PGTAP_FIXTURE_BOOTSTRAP_RETRY_DELAY_MS: '250',
        },
        now: () => fakeNow,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
          fakeNow += ms;
        },
        logger: { warn: jest.fn() },
      },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleepCalls).toEqual([250, 500]);
  });

  test('withFixtureBootstrapRetry retries deadlock failures', async () => {
    const sleepCalls = [];
    let fakeNow = 0;
    let attempts = 0;

    const result = await withFixtureBootstrapRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) {
          throw Object.assign(new Error('deadlock detected'), {
            code: '40P01',
          });
        }
        return 'ok';
      },
      {
        env: {
          PGTAP_FIXTURE_BOOTSTRAP_MAX_WAIT_MS: '10000',
          PGTAP_FIXTURE_BOOTSTRAP_RETRY_DELAY_MS: '300',
        },
        now: () => fakeNow,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
          fakeNow += ms;
        },
        logger: { warn: jest.fn() },
      },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(sleepCalls).toEqual([300]);
  });
});
