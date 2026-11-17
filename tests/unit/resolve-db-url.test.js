const {
  isRetryableDbConnectError,
  parsePositiveInt,
  resolveEnvOverride,
  resolveDatabaseUrlWithFallback,
} = require('../../scripts/utils/resolve-db-url');
const Module = require('module');

const resolveDbUrlPath = require.resolve('../../scripts/utils/resolve-db-url');

describe('resolve-db-url', () => {
  test('can be imported without pg until the default connectivity probe is used', () => {
    const originalLoad = Module._load;
    delete require.cache[resolveDbUrlPath];
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'pg') {
        throw new Error('synthetic missing pg');
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      const fresh = require(resolveDbUrlPath);
      expect(fresh.parsePositiveInt('25', 10)).toBe(25);
      expect(fresh.resolveEnvOverride({ DATABASE_URL: 'postgres://x' }, ['DATABASE_URL'])).toBe('postgres://x');
    } finally {
      Module._load = originalLoad;
      delete require.cache[resolveDbUrlPath];
      require(resolveDbUrlPath);
    }
  });

  test('parsePositiveInt returns fallback for invalid inputs', () => {
    expect(parsePositiveInt('', 10)).toBe(10);
    expect(parsePositiveInt('abc', 10)).toBe(10);
    expect(parsePositiveInt('-5', 10)).toBe(10);
    expect(parsePositiveInt('25', 10)).toBe(25);
  });

  test('isRetryableDbConnectError classifies transient db failures', () => {
    expect(isRetryableDbConnectError(new Error('Tenant or user not found'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('password authentication failed for user'))).toBe(true);
    expect(
      isRetryableDbConnectError(
        new Error('Circuit breaker open: Unable to establish connection to upstream database'),
      ),
    ).toBe(true);
    expect(isRetryableDbConnectError(new Error('syntax error at or near select'))).toBe(false);
  });

  test('resolveDatabaseUrlWithFallback falls through candidates within the same attempt', async () => {
    const logger = { warn: jest.fn() };
    const probe = jest.fn(async (candidate) => {
      if (candidate.name === 'DATABASE_URL') {
        throw new Error('password authentication failed');
      }
    });

    const result = await resolveDatabaseUrlWithFallback({
      env: {},
      candidates: [
        { name: 'DATABASE_URL', dsn: 'postgres://primary' },
        { name: 'DATABASE_URL_POOLER', dsn: 'postgres://pooler' },
      ],
      probe,
      logger,
      maxWaitMs: 2000,
      retryDelayMs: 1,
    });

    expect(result.candidateName).toBe('DATABASE_URL_POOLER');
    expect(result.dsn).toBe('postgres://pooler');
    expect(result.attempts).toBe(1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test('resolveDatabaseUrlWithFallback retries transient errors across attempts', async () => {
    const logger = { warn: jest.fn() };
    let calls = 0;
    const probe = jest.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('tenant or user not found');
      }
    });

    const result = await resolveDatabaseUrlWithFallback({
      env: {},
      candidates: [{ name: 'DATABASE_URL', dsn: 'postgres://primary' }],
      probe,
      logger,
      maxWaitMs: 5000,
      retryDelayMs: 1,
    });

    expect(result.candidateName).toBe('DATABASE_URL');
    expect(result.attempts).toBe(3);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  test('resolveDatabaseUrlWithFallback throws when no candidates exist', async () => {
    await expect(
      resolveDatabaseUrlWithFallback({
        env: {},
        candidates: [],
      }),
    ).rejects.toThrow('Missing DATABASE_URL');
  });

  test('resolveDatabaseUrlWithFallback applies shared-lane-safe candidate policy before probing', async () => {
    const probe = jest.fn(async () => {});

    const result = await resolveDatabaseUrlWithFallback({
      env: {},
      candidatePolicy: 'shared-lane-safe',
      candidates: [
        { name: 'DATABASE_URL_DIRECT', dsn: (['postgresql',":","/","/",'postgres',":",'nqvzjiyjgtjrykszszntwnho',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
        { name: 'DATABASE_URL_POOLER', dsn: (['postgresql',":","/","/",'postgres.wk123',":",'trxsxxlslvipgphxjqyxvnww',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
      ],
      probe,
      logger: { warn: jest.fn() },
      maxWaitMs: 2000,
      retryDelayMs: 1,
    });

    expect(result.candidateName).toBe('DATABASE_URL_POOLER');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'DATABASE_URL_POOLER' }),
    );
  });

  test('resolveDatabaseUrlWithFallback applies longer delay for circuit-breaker retries', async () => {
    const sleepCalls = [];
    let fakeNow = 0;

    await expect(
      resolveDatabaseUrlWithFallback({
        candidates: [{ name: 'DATABASE_URL', dsn: 'postgres://primary' }],
        probe: async () => {
          throw new Error('Circuit breaker open: Unable to establish connection to upstream database');
        },
        maxWaitMs: 9000,
        retryDelayMs: 1000,
        circuitBreakerRetryDelayMs: 7000,
        now: () => fakeNow,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
          fakeNow += ms;
        },
        logger: { warn: jest.fn() },
      }),
    ).rejects.toThrow('DB connectivity smoke failed');

    expect(sleepCalls[0]).toBe(7000);
  });

  test('resolveEnvOverride prefers the first populated env name', () => {
    const env = {
      DEPLOY_DB_CONNECT_MAX_WAIT_MS: '240000',
      DEMO_ACCOUNTS_DB_CONNECT_MAX_WAIT_MS: '180000',
    };

    expect(
      resolveEnvOverride(
        env,
        ['DEPLOY_DB_CONNECT_MAX_WAIT_MS', 'DEMO_ACCOUNTS_DB_CONNECT_MAX_WAIT_MS'],
        'DB_CONNECT_MAX_WAIT_MS',
      ),
    ).toBe('240000');
  });

  test('resolveDatabaseUrlWithFallback forwards password-sync stabilization overrides', async () => {
    const probe = jest.fn(async (candidate) => {
      if (candidate.name === 'DATABASE_URL') {
        throw new Error('password authentication failed for user "postgres"');
      }
    });
    const sleepCalls = [];
    let fakeNow = 0;

    await expect(
      resolveDatabaseUrlWithFallback({
        env: {
          DEPLOY_DB_CONNECT_PASSWORD_SYNC_STABILIZE_MS: '7000',
          SUPABASE_ACCESS_TOKEN: 'token',
          SUPABASE_PROJECT_ID: 'af38b526-f5c1-468d-88fb-86677fbe872a',
          SUPABASE_DB_PASSWORD: 'secret',
        },
        candidates: [{ name: 'DATABASE_URL', dsn: 'postgres://primary' }],
        probe,
        logger: { warn: jest.fn() },
        buildPasswordSyncedCandidatesFn: async () => [{ name: 'SYNCED_DB_URL', dsn: 'postgres://fresh' }],
        syncProjectDbPassword: async () => ({ ok: true }),
        passwordSyncStabilizeEnvNames: ['DEPLOY_DB_CONNECT_PASSWORD_SYNC_STABILIZE_MS'],
        maxWaitMs: 12000,
        retryDelayMs: 1000,
        now: () => fakeNow,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
          fakeNow += ms;
        },
      }),
    ).resolves.toMatchObject({
      candidateName: 'SYNCED_DB_URL',
      dsn: 'postgres://fresh',
    });

    expect(sleepCalls).toContain(7000);
  });
});
