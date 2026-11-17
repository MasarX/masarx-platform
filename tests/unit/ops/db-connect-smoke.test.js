const path = require('path');
const Module = require('module');
const fs = require('fs');
const os = require('os');

const smokePath = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'db-connect-smoke.js');
const {
  buildPasswordSyncedCandidates,
  filterCandidatesByPolicy,
  isRetryableDbConnectError,
  parsePositiveInt,
  pinSelectedDsnForDownstream,
  resolveDsnCandidates,
  runConnectivitySmoke,
  isCircuitBreakerCredentialError,
  isSupabaseDirectCandidate,
  normalizeCandidatePolicy,
  isProjectDbPasswordSyncAllowed,
  shouldSyncTenantNotFoundOnPreviewEnv,
  shouldAttemptDbPasswordSync,
  resolveDbManagementCredentials,
} = require(smokePath);

describe('db-connect-smoke', () => {
  test('can be imported without pg until the default DB probe is used', () => {
    const originalLoad = Module._load;
    delete require.cache[smokePath];
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'pg') {
        throw new Error('synthetic missing pg');
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      const fresh = require(smokePath);
      expect(fresh.parsePositiveInt('25', 10)).toBe(25);
    } finally {
      Module._load = originalLoad;
      delete require.cache[smokePath];
      require(smokePath);
    }
  });

  test('retries on transient auth lag and eventually succeeds', async () => {
    const candidates = [{ name: 'DATABASE_URL', dsn: 'postgresql://example' }];
    const warnings = [];
    const syncProjectDbPassword = jest.fn(async () => ({ ok: true }));
    let fakeNow = 0;
    let calls = 0;

    const result = await runConnectivitySmoke({
      candidates,
      env: {},
      maxWaitMs: 10000,
      retryDelayMs: 2000,
      now: () => fakeNow,
      sleepFn: async (ms) => { fakeNow += ms; },
      logger: { warn: (msg) => warnings.push(msg) },
      syncProjectDbPassword,
      probe: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('Tenant or user not found');
        }
      },
    });

    expect(result.attempts).toBe(3);
    expect(result.candidate.name).toBe('DATABASE_URL');
    expect(syncProjectDbPassword).not.toHaveBeenCalled();
    expect(warnings.some((msg) => msg.includes('Retrying DB connect ladder'))).toBe(true);
  });

  test('fails fast on non-retryable connectivity errors', async () => {
    const candidates = [{ name: 'DATABASE_URL', dsn: 'postgresql://example' }];
    const sleepCalls = [];

    await expect(
      runConnectivitySmoke({
        candidates,
        maxWaitMs: 10000,
        retryDelayMs: 2000,
        sleepFn: async (ms) => { sleepCalls.push(ms); },
        logger: { warn: jest.fn() },
        probe: async () => {
          throw new Error('role "invalid" does not exist');
        },
      }),
    ).rejects.toThrow('role "invalid" does not exist');

    expect(sleepCalls).toHaveLength(0);
  });

  test('resolves candidate ladder from environment using shared builder hooks', async () => {
    const env = {
      DATABASE_URL: (['postgresql',":","/","/",'user',":",'zskmlxqmrhswsoxmulqzolrx',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
      DATABASE_URL_DIRECT: '',
      DATABASE_URL_POOLER: '',
    };

    const candidates = await resolveDsnCandidates({
      env,
      ensureIpv4HostnameFn: async (dsn) => `${dsn}?variant=ipv4`,
      ensureHostaddrFn: async (dsn) => `${dsn}?variant=hostaddr`,
    });

    expect(candidates.map((c) => c.name)).toEqual([
      'DATABASE_URL+ipv4host',
      'DATABASE_URL+hostaddr',
      'DATABASE_URL',
    ]);
  });

  test('keeps an unlabelled PG_CONN_STRING first in the fallback ladder', async () => {
    const env = {
      PG_CONN_STRING: (['postgresql',":","/","/",'pinned',":",'kkzusxjunipmwghvuypqwrto',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
      DATABASE_URL: (['postgresql',":","/","/",'raw',":",'qhtoiguwpkljsprogplltytz',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
    };

    const candidates = await resolveDsnCandidates({
      env,
      ensureIpv4HostnameFn: async (dsn) => dsn,
      ensureHostaddrFn: async (dsn) => dsn,
    });

    expect(candidates[0]).toEqual({
      name: 'PG_CONN_STRING',
      dsn: env.PG_CONN_STRING,
    });
    expect(candidates.some((candidate) => candidate.name === 'DATABASE_URL')).toBe(true);
  });

  test('omits a whitespace-only unlabelled PG_CONN_STRING from the fallback ladder', async () => {
    const env = {
      PG_CONN_STRING: '   ',
      DATABASE_URL: (['postgresql',":","/","/",'raw',":",'qhtoiguwpkljsprogplltytz',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
    };

    const candidates = await resolveDsnCandidates({
      env,
      ensureIpv4HostnameFn: async (dsn) => dsn,
      ensureHostaddrFn: async (dsn) => dsn,
    });

    expect(candidates.some((candidate) => candidate.name === 'PG_CONN_STRING')).toBe(false);
    expect(candidates.some((candidate) => candidate.name === 'DATABASE_URL')).toBe(true);
  });

  test('shared-lane-safe policy excludes Supabase direct candidates but keeps pooler and custom hosts', async () => {
    const env = {
      DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'nqvzjiyjgtjrykszszntwnho',"@",'example.invalid',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      DATABASE_URL_POOLER: (['postgresql',":","/","/",'postgres.wk123',":",'trxsxxlslvipgphxjqyxvnww',"@",'example.invalid',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      SYNCED_DB_URL_DIRECT: (['postgresql',":","/","/",'postgres',":",'nqvzjiyjgtjrykszszntwnho',"@",'example.invalid',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      PG_CONN_STRING: (['postgresql',":","/","/",'postgres',":",'pw',"@",'db.internal.example',":",'5432',"/",'postgres'].join("")),
      DB_SMOKE_SELECTED_DSN_NAME: 'PG_CONN_STRING',
    };

    const candidates = await resolveDsnCandidates({
      env,
      candidatePolicy: 'shared-lane-safe',
      ensureIpv4HostnameFn: async (dsn) => dsn,
      ensureHostaddrFn: async (dsn) => dsn,
    });

    expect(candidates.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining([
        'PG_CONN_STRING',
        'DATABASE_URL_POOLER',
      ]),
    );
    expect(candidates.some((candidate) => isSupabaseDirectCandidate(candidate))).toBe(false);
  });

  test('shared-lane-safe policy keeps the governed loopback database candidate', async () => {
    const candidates = await resolveDsnCandidates({
      env: {
        DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'postgres',"@",'127.0.0.1',":",'23197',"/",'postgres'].join("")),
      },
      candidatePolicy: 'shared-lane-safe',
      ensureIpv4HostnameFn: async (dsn) => dsn,
      ensureHostaddrFn: async (dsn) => dsn,
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        name: 'DATABASE_URL',
        dsn: (['postgresql',":","/","/",'postgres',":",'postgres',"@",'127.0.0.1',":",'23197',"/",'postgres'].join("")),
      }),
    ]);
  });

  test('prefers a previously pinned downstream DSN ahead of stale direct or pooler hints', async () => {
    const env = {
      DB_SMOKE_SELECTED_DSN_NAME: 'SYNCED_DB_URL_POOLER+hostaddr',
      PG_CONN_STRING: (['postgresql',":","/","/",'selected-user',":",'selected-pass',"@",'192.0.2.10',":",'5432',"/",'postgres',"?",'hostaddr=192.0.2.10'].join("")),
      DATABASE_URL: (['postgresql',":","/","/",'selected-user',":",'selected-pass',"@",'192.0.2.10',":",'5432',"/",'postgres',"?",'hostaddr=192.0.2.10'].join("")),
      DATABASE_URL_DIRECT: (['postgresql',":","/","/",'stale-direct-user',":",'utkomjmytssvxiognlsmqwyu',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
      DATABASE_URL_POOLER: (['postgresql',":","/","/",'stale-pooler-user',":",'sniygovjwswvihhqzpoiggvw',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
    };

    const candidates = await resolveDsnCandidates({
      env,
      ensureIpv4HostnameFn: async (dsn) => dsn,
      ensureHostaddrFn: async (dsn) => dsn,
    });

    expect(candidates[0]).toEqual({
      name: 'SYNCED_DB_URL_POOLER+hostaddr',
      dsn: (['postgresql',":","/","/",'selected-user',":",'selected-pass',"@",'192.0.2.10',":",'5432',"/",'postgres',"?",'hostaddr=192.0.2.10'].join("")),
    });
    expect(candidates.slice(1).map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining([
        'DATABASE_URL_DIRECT',
        'DATABASE_URL_POOLER',
      ]),
    );
  });

  test('classifies retryable connect errors and parses positive integers safely', () => {
    expect(isRetryableDbConnectError(new Error('Tenant or user not found'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('network is unreachable'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('the database system is starting up'))).toBe(true);
    expect(
      isRetryableDbConnectError(
        Object.assign(new Error('connection startup pending'), { code: '57P03' }),
      ),
    ).toBe(true);
    expect(
      isRetryableDbConnectError(
        new Error('Circuit breaker open: Unable to establish connection to upstream database'),
      ),
    ).toBe(true);
    expect(isRetryableDbConnectError(new Error('syntax error at or near select'))).toBe(false);

    expect(parsePositiveInt('2500', 100)).toBe(2500);
    expect(parsePositiveInt('0', 100)).toBe(100);
    expect(parsePositiveInt('not-a-number', 100)).toBe(100);
  });

  test('retries when Postgres reports startup in progress', async () => {
    const candidates = [{ name: 'DATABASE_URL', dsn: 'postgresql://example' }];
    const sleepCalls = [];
    let fakeNow = 0;
    let probeCalls = 0;

    const result = await runConnectivitySmoke({
      candidates,
      env: {},
      maxWaitMs: 10000,
      retryDelayMs: 2000,
      now: () => fakeNow,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
        fakeNow += ms;
      },
      logger: { warn: jest.fn() },
      probe: async () => {
        probeCalls += 1;
        if (probeCalls === 1) {
          throw new Error('the database system is starting up');
        }
      },
    });

    expect(result.attempts).toBe(2);
    expect(result.candidate.name).toBe('DATABASE_URL');
    expect(sleepCalls).toEqual([2000]);
  });

  test('normalizes candidate policies and detects Supabase direct routes', () => {
    expect(normalizeCandidatePolicy('pooler-safe')).toBe('shared-lane-safe');
    expect(normalizeCandidatePolicy('shared_lane_safe')).toBe('shared-lane-safe');
    expect(normalizeCandidatePolicy('')).toBe('default');
    expect(
      isSupabaseDirectCandidate({
        name: 'DATABASE_URL',
        dsn: (['postgresql',":","/","/",'postgres',":",'nqvzjiyjgtjrykszszntwnho',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
      }),
    ).toBe(true);
    expect(
      isSupabaseDirectCandidate({
        name: 'DATABASE_URL_POOLER',
        dsn: (['postgresql',":","/","/",'postgres.wk123',":",'trxsxxlslvipgphxjqyxvnww',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
      }),
    ).toBe(false);
    expect(
      filterCandidatesByPolicy(
        [
          { name: 'DATABASE_URL_DIRECT', dsn: (['postgresql',":","/","/",'postgres',":",'nqvzjiyjgtjrykszszntwnho',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
          { name: 'DATABASE_URL_POOLER', dsn: (['postgresql',":","/","/",'postgres.wk123',":",'trxsxxlslvipgphxjqyxvnww',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
        ],
        'shared-lane-safe',
      ),
    ).toEqual([
      { name: 'DATABASE_URL_POOLER', dsn: (['postgresql',":","/","/",'postgres.wk123',":",'trxsxxlslvipgphxjqyxvnww',"@",'example.invalid',":",'5432',"/",'postgres'].join("")) },
    ]);
  });

  test('recognizes circuit-breaker credential failures as password-sync candidates', () => {
    expect(
      isCircuitBreakerCredentialError(
        new Error('Circuit breaker open: Failed to retrieve database credentials'),
      ),
    ).toBe(true);
    expect(
      shouldAttemptDbPasswordSync({
        env: {
          SUPABASE_ACCESS_TOKEN: 'token',
          SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
          SUPABASE_DB_PASSWORD: 'secret',
        },
        lastError: new Error('Circuit breaker open: Failed to retrieve database credentials'),
        alreadyAttempted: false,
      }),
    ).toBe(true);
  });

  test('runConnectivitySmoke applies circuit-breaker retry delay when upstream circuit is open', async () => {
    const candidates = [{ name: 'DATABASE_URL', dsn: 'postgresql://example' }];
    const sleepCalls = [];
    let fakeNow = 0;

    await expect(
      runConnectivitySmoke({
        candidates,
        maxWaitMs: 9000,
        retryDelayMs: 1000,
        circuitBreakerRetryDelayMs: 7000,
        now: () => fakeNow,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
          fakeNow += ms;
        },
        logger: { warn: jest.fn() },
        probe: async () => {
          throw new Error('Circuit breaker open: Unable to establish connection to upstream database');
        },
      }),
    ).rejects.toThrow('DB connectivity smoke failed');

    expect(sleepCalls[0]).toBe(7000);
  });

  test('attempts one-time DB password sync on auth failures when management credentials are present', async () => {
    const candidates = [{ name: 'DATABASE_URL', dsn: 'postgresql://example' }];
    let fakeNow = 0;
    let probeCalls = 0;
    const syncProjectDbPassword = jest.fn(async () => ({ ok: true }));

    const result = await runConnectivitySmoke({
      candidates,
      env: {
        SUPABASE_ACCESS_TOKEN: 'token',
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret',
      },
      maxWaitMs: 10000,
      retryDelayMs: 2000,
      now: () => fakeNow,
      sleepFn: async (ms) => { fakeNow += ms; },
      logger: { warn: jest.fn() },
      syncProjectDbPassword,
      buildPasswordSyncedCandidatesFn: async () => [],
      probe: async () => {
        probeCalls += 1;
        if (probeCalls === 1) {
          throw new Error('password authentication failed for user "postgres"');
        }
      },
    });

    expect(result.attempts).toBe(2);
    expect(syncProjectDbPassword).toHaveBeenCalledTimes(1);
  });

  test('does not sync DB password on tenant/user-not-found outside preview env by default', async () => {
    const candidates = [{ name: 'DATABASE_URL', dsn: 'postgresql://example' }];
    let fakeNow = 0;
    const syncProjectDbPassword = jest.fn(async () => ({ ok: true }));

    await expect(
      runConnectivitySmoke({
        candidates,
        env: {
          SUPABASE_ACCESS_TOKEN: 'token',
          SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
          SUPABASE_DB_PASSWORD: 'secret',
        },
        maxWaitMs: 3000,
        retryDelayMs: 1000,
        now: () => fakeNow,
        sleepFn: async (ms) => { fakeNow += ms; },
        logger: { warn: jest.fn() },
        syncProjectDbPassword,
        probe: async () => {
          throw new Error('Tenant or user not found');
        },
      }),
    ).rejects.toThrow('Tenant or user not found');

    expect(syncProjectDbPassword).toHaveBeenCalledTimes(0);
  });

  test('auto-syncs DB password on tenant/user-not-found for resolved project previews by default', async () => {
    const candidates = [{ name: 'DATABASE_URL', dsn: 'postgresql://example' }];
    let fakeNow = 0;
    let probeCalls = 0;
    const syncProjectDbPassword = jest.fn(async () => ({ ok: true }));

    const result = await runConnectivitySmoke({
      candidates,
      env: {
        SUPABASE_ACCESS_TOKEN: 'token',
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret',
        PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
        PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
      },
      maxWaitMs: 10000,
      retryDelayMs: 2000,
      now: () => fakeNow,
      sleepFn: async (ms) => { fakeNow += ms; },
      logger: { warn: jest.fn() },
      syncProjectDbPassword,
      buildPasswordSyncedCandidatesFn: async () => [],
      probe: async () => {
        probeCalls += 1;
        if (probeCalls === 1) {
          throw new Error('Tenant or user not found');
        }
      },
    });

    expect(result.attempts).toBe(2);
    expect(syncProjectDbPassword).toHaveBeenCalledTimes(1);
  });

  test('fails closed for branch and unresolved-auto preview password sync even with explicit overrides', async () => {
    const credentials = {
      SUPABASE_ACCESS_TOKEN: 'token',
      SUPABASE_PROJECT_ID: '5fd7e30a-80df-483b-955c-7a633c6ba9d6',
      SUPABASE_DB_PASSWORD: 'branch-password',
      DB_SMOKE_SYNC_DB_PASSWORD: '1',
      DB_SMOKE_SYNC_ON_TENANT_NOT_FOUND: '1',
    };

    expect(isProjectDbPasswordSyncAllowed({
      ...credentials,
      PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
    })).toBe(false);
    expect(isProjectDbPasswordSyncAllowed({
      ...credentials,
      PREVIEW_SUPABASE_WORKSPACE_MODE: 'branch',
      PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
    })).toBe(false);
    expect(isProjectDbPasswordSyncAllowed({
      ...credentials,
      PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
      PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
    })).toBe(true);
    expect(isProjectDbPasswordSyncAllowed({
      ...credentials,
      PREVIEW_SUPABASE_WORKSPACE_MODE: 'project',
      PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'branch',
    })).toBe(false);
    expect(isProjectDbPasswordSyncAllowed({
      ...credentials,
      PREVIEW_SUPABASE_WORKSPACE_MODE: 'invalid',
      PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
    })).toBe(false);
    expect(isProjectDbPasswordSyncAllowed({
      ...credentials,
      WORKSPACE_MODE: 'branch',
    })).toBe(false);
    expect(isProjectDbPasswordSyncAllowed({
      ...credentials,
      WORKSPACE_MODE: 'auto',
    })).toBe(false);
    expect(isProjectDbPasswordSyncAllowed({
      ...credentials,
      WORKSPACE_MODE: 'project',
    })).toBe(true);

    for (const lastError of [
      new Error('password authentication failed for user "postgres"'),
      new Error('Tenant or user not found'),
      new Error('Circuit breaker open: Failed to retrieve database credentials'),
    ]) {
      expect(shouldAttemptDbPasswordSync({
        env: {
          ...credentials,
          PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
          PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'branch',
        },
        lastError,
      })).toBe(false);
    }

    // Preview detection remains available to callers that use it for safe DSN
    // policy selection; the separate project-sync eligibility gate is decisive.
    expect(shouldSyncTenantNotFoundOnPreviewEnv({
      ...credentials,
      PREVIEW_SUPABASE_WORKSPACE_MODE: 'branch',
    })).toBe(true);

    let fakeNow = 0;
    const syncProjectDbPassword = jest.fn(async () => ({ ok: true }));
    await expect(
      runConnectivitySmoke({
        candidates: [{ name: 'DATABASE_URL', dsn: 'postgresql://example' }],
        env: {
          ...credentials,
          PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
          PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'branch',
        },
        maxWaitMs: 1000,
        retryDelayMs: 1000,
        now: () => fakeNow,
        sleepFn: async (ms) => { fakeNow += ms; },
        logger: { warn: jest.fn() },
        syncProjectDbPassword,
        probe: async () => {
          throw new Error('password authentication failed for user "postgres"');
        },
      }),
    ).rejects.toThrow('password authentication failed');
    expect(syncProjectDbPassword).not.toHaveBeenCalled();
  });

  test('resolves management credentials from preview-prefixed env when shared vars are absent', () => {
    const resolved = resolveDbManagementCredentials({
      PREVIEW_SUPABASE_ACCESS_TOKEN: 'EXAMPLE_PASSWORD',
      PREVIEW_SUPABASE_DB_PASSWORD: 'EXAMPLE_PASSWORD',
      PREVIEW_SUPABASE_REGION: 'eu-north-1',
      PREVIEW_SUPABASE_POOLER_HOST: 'aws-1-eu-north-1.pooler.supabase.com',
      PREVIEW_SUPABASE_POOLER_PORT: '6543',
      PREVIEW_SUPABASE_POOLER_USER: 'postgres.preview',
      PREVIEW_PROJECT_REF: '46b364a4-da77-4f71-9e7b-f34b567e3dbe',
    });

    expect(resolved).toEqual({
      token: 'EXAMPLE_PASSWORD',
      projectRef: '46b364a4-da77-4f71-9e7b-f34b567e3dbe',
      password: 'EXAMPLE_PASSWORD',
      region: 'eu-north-1',
      poolerHost: 'aws-1-eu-north-1.pooler.supabase.com',
      poolerPort: '6543',
      poolerUser: 'postgres.preview',
    });
  });

  test('preview-prefixed management credentials allow password sync on preview auth lag', () => {
    expect(
      shouldAttemptDbPasswordSync({
        env: {
          PREVIEW_SUPABASE_ACCESS_TOKEN: 'EXAMPLE_PASSWORD',
          PREVIEW_SUPABASE_DB_PASSWORD: 'EXAMPLE_PASSWORD',
          PREVIEW_PROJECT_REF: '46b364a4-da77-4f71-9e7b-f34b567e3dbe',
          PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
          PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
        },
        lastError: new Error('Tenant or user not found'),
        alreadyAttempted: false,
      }),
    ).toBe(true);
  });

  test('replaces stale candidates with synced ladder and waits for propagation after password sync', async () => {
    let fakeNow = 0;
    const sleepCalls = [];
    const probeOrder = [];
    const syncProjectDbPassword = jest.fn(async () => ({ ok: true }));

    const result = await runConnectivitySmoke({
      candidates: [{ name: 'DATABASE_URL_POOLER', dsn: 'postgresql://stale-primary' }],
      env: {
        SUPABASE_ACCESS_TOKEN: 'token',
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret',
      },
      maxWaitMs: 20000,
      retryDelayMs: 1000,
      passwordSyncStabilizeMs: 5000,
      now: () => fakeNow,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
        fakeNow += ms;
      },
      logger: { warn: jest.fn() },
      syncProjectDbPassword,
      buildPasswordSyncedCandidatesFn: async () => [
        { name: 'SYNCED_DB_URL_POOLER', dsn: 'postgresql://fresh-primary' },
      ],
      probe: async (candidate) => {
        probeOrder.push(candidate.name);
        if (candidate.name === 'DATABASE_URL_POOLER') {
          throw new Error('password authentication failed for user "postgres"');
        }
      },
    });

    expect(result.candidate.name).toBe('SYNCED_DB_URL_POOLER');
    expect(probeOrder).toEqual(['DATABASE_URL_POOLER', 'SYNCED_DB_URL_POOLER']);
    expect(syncProjectDbPassword).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toContain(5000);
  });

  test('buildPasswordSyncedCandidates honors a previously selected synced candidate name', async () => {
    const candidates = await buildPasswordSyncedCandidates({
      env: {
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret-pass',
        SUPABASE_REGION: 'eu-north-1',
        SUPABASE_POOLER_USER: 'postgres',
        DB_SMOKE_SELECTED_DSN_NAME: 'SYNCED_DB_URL_POOLER+poolerport:6543',
      },
      ensureIpv4HostnameFn: async (dsn) => dsn,
      ensureHostaddrFn: async (dsn) => dsn,
    });

    expect(candidates[0]?.name).toBe('SYNCED_DB_URL_POOLER+poolerport:6543');
  });

  test('allows tenant/user-not-found DB password sync only with explicit opt-in flag', async () => {
    const candidates = [{ name: 'DATABASE_URL', dsn: 'postgresql://example' }];
    let fakeNow = 0;
    let probeCalls = 0;
    const syncProjectDbPassword = jest.fn(async () => ({ ok: true }));

    const result = await runConnectivitySmoke({
      candidates,
      env: {
        SUPABASE_ACCESS_TOKEN: 'token',
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret',
        DB_SMOKE_SYNC_ON_TENANT_NOT_FOUND: '1',
      },
      maxWaitMs: 10000,
      retryDelayMs: 2000,
      now: () => fakeNow,
      sleepFn: async (ms) => { fakeNow += ms; },
      logger: { warn: jest.fn() },
      syncProjectDbPassword,
      buildPasswordSyncedCandidatesFn: async () => [],
      probe: async () => {
        probeCalls += 1;
        if (probeCalls === 1) {
          throw new Error('Tenant or user not found');
        }
      },
    });

    expect(result.attempts).toBe(2);
    expect(syncProjectDbPassword).toHaveBeenCalledTimes(1);
  });

  test('password sync helper stays disabled in production by default', () => {
    const shouldSync = shouldAttemptDbPasswordSync({
      env: {
        PROD_DEPLOY_GUARD: 'enabled',
        SUPABASE_ACCESS_TOKEN: 'token',
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret',
      },
      lastError: new Error('password authentication failed for user "postgres"'),
      alreadyAttempted: false,
    });
    expect(shouldSync).toBe(false);
  });

  test('preview tenant-not-found sync auto-default honors explicit opt-out', () => {
    expect(
      shouldSyncTenantNotFoundOnPreviewEnv({
        PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
        PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
        DB_SMOKE_SYNC_ON_TENANT_NOT_FOUND: '0',
      }),
    ).toBe(false);
    expect(
      shouldSyncTenantNotFoundOnPreviewEnv({
        PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
        PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
      }),
    ).toBe(true);
  });

  test('buildPasswordSyncedCandidates synthesizes pooler/direct DSNs from managed password inputs', async () => {
    const candidates = await buildPasswordSyncedCandidates({
      env: {
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret-pass',
        SUPABASE_REGION: 'eu-north-1',
        SUPABASE_POOLER_USER: 'postgres',
      },
      ensureIpv4HostnameFn: async (dsn) => dsn,
      ensureHostaddrFn: async (dsn) => dsn,
    });

    const names = candidates.map((candidate) => candidate.name);
    expect(names).toContain('SYNCED_DB_URL_POOLER');
    expect(names).toContain('SYNCED_DB_URL_DIRECT');
    const poolerDsn = candidates.find((candidate) => candidate.name === 'SYNCED_DB_URL_POOLER')?.dsn || '';
    expect(poolerDsn).toContain('postgres.syxokyiulhqvrpjtjqzi');
    expect(poolerDsn).toContain('aws-1-eu-north-1.pooler.supabase.com');
  });

  test('buildPasswordSyncedCandidates uses preview-prefixed management inputs when shared vars are missing', async () => {
    const candidates = await buildPasswordSyncedCandidates({
      env: {
        PREVIEW_PROJECT_REF: '46b364a4-da77-4f71-9e7b-f34b567e3dbe',
        PREVIEW_SUPABASE_DB_PASSWORD: 'EXAMPLE_PASSWORD',
        PREVIEW_SUPABASE_REGION: 'eu-north-1',
        PREVIEW_SUPABASE_POOLER_HOST: 'aws-1-eu-north-1.pooler.supabase.com',
        PREVIEW_SUPABASE_POOLER_PORT: '6543',
      },
      ensureIpv4HostnameFn: async (dsn) => dsn,
      ensureHostaddrFn: async (dsn) => dsn,
    });

    expect(candidates.map((candidate) => candidate.name)).toContain('SYNCED_DB_URL_POOLER');
    const poolerDsn = candidates.find((candidate) => candidate.name === 'SYNCED_DB_URL_POOLER')?.dsn || '';
    expect(poolerDsn).toContain('postgres.46b364a4-da77-4f71-9e7b-f34b567e3dbe');
    expect(poolerDsn).toContain('aws-1-eu-north-1.pooler.supabase.com:6543');
  });

  test('runConnectivitySmoke replaces retry ladder with password-synced candidates after successful sync', async () => {
    const probeOrder = [];
    const warnings = [];
    let fakeNow = 0;

    const result = await runConnectivitySmoke({
      candidates: [{ name: 'DATABASE_URL', dsn: 'postgresql://stale' }],
      env: {
        SUPABASE_ACCESS_TOKEN: 'token',
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret',
      },
      maxWaitMs: 10000,
      retryDelayMs: 2000,
      now: () => fakeNow,
      sleepFn: async (ms) => { fakeNow += ms; },
      logger: { warn: (msg) => warnings.push(msg) },
      syncProjectDbPassword: jest.fn(async () => ({ ok: true })),
      buildPasswordSyncedCandidatesFn: async () => [{ name: 'SYNCED_DB_URL', dsn: 'postgresql://synced' }],
      probe: async (candidate) => {
        probeOrder.push(candidate.name);
        if (candidate.name === 'DATABASE_URL') {
          throw new Error('password authentication failed for user "postgres"');
        }
      },
    });

    expect(result.candidate.name).toBe('SYNCED_DB_URL');
    expect(probeOrder).toEqual(['DATABASE_URL', 'SYNCED_DB_URL']);
    expect(
      warnings.some((msg) => msg.includes('Replaced DB retry ladder with 1 password-synced candidate')),
    ).toBe(true);
  });

  test('buildPasswordSyncedCandidates keeps only pooler-safe routes under shared-lane-safe policy', async () => {
    const candidates = await buildPasswordSyncedCandidates({
      env: {
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret-pass',
        SUPABASE_REGION: 'eu-north-1',
      },
      candidatePolicy: 'shared-lane-safe',
      ensureIpv4HostnameFn: async (dsn) => dsn,
      ensureHostaddrFn: async (dsn) => dsn,
    });

    expect(candidates.map((candidate) => candidate.name)).toContain('SYNCED_DB_URL_POOLER');
    expect(candidates.some((candidate) => candidate.name.includes('DIRECT'))).toBe(false);
  });

  test('runConnectivitySmoke retries with synced candidates after credential circuit-breaker failures', async () => {
    const probeOrder = [];
    let fakeNow = 0;
    const syncProjectDbPassword = jest.fn(async () => ({ ok: true }));

    const result = await runConnectivitySmoke({
      candidates: [{ name: 'DATABASE_URL', dsn: 'postgresql://stale' }],
      env: {
        SUPABASE_ACCESS_TOKEN: 'token',
        SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
        SUPABASE_DB_PASSWORD: 'secret',
      },
      maxWaitMs: 10000,
      retryDelayMs: 2000,
      now: () => fakeNow,
      sleepFn: async (ms) => { fakeNow += ms; },
      logger: { warn: jest.fn() },
      syncProjectDbPassword,
      buildPasswordSyncedCandidatesFn: async () => [{ name: 'SYNCED_DB_URL', dsn: 'postgresql://synced' }],
      probe: async (candidate) => {
        probeOrder.push(candidate.name);
        if (candidate.name === 'DATABASE_URL') {
          throw new Error('Circuit breaker open: Failed to retrieve database credentials');
        }
      },
    });

    expect(result.candidate.name).toBe('SYNCED_DB_URL');
    expect(syncProjectDbPassword).toHaveBeenCalledTimes(1);
    expect(probeOrder).toEqual(['DATABASE_URL', 'SYNCED_DB_URL']);
  });

  test('runConnectivitySmoke does not trigger password sync when auth drift is tenant mismatch only', async () => {
    const probeOrder = [];
    let fakeNow = 0;

    const syncProjectDbPassword = jest.fn(async () => ({ ok: true }));

    await expect(
      runConnectivitySmoke({
        candidates: [
          { name: 'DATABASE_URL', dsn: 'postgresql://stale' },
          { name: 'DATABASE_URL_DIRECT', dsn: 'postgresql://direct' },
        ],
        env: {
          SUPABASE_ACCESS_TOKEN: 'token',
          SUPABASE_PROJECT_ID: 'syxokyiulhqvrpjtjqzi',
          SUPABASE_DB_PASSWORD: 'secret',
        },
        maxWaitMs: 3000,
        retryDelayMs: 1000,
        now: () => fakeNow,
        sleepFn: async (ms) => { fakeNow += ms; },
        logger: { warn: jest.fn() },
        syncProjectDbPassword,
        buildPasswordSyncedCandidatesFn: async () => [{ name: 'SYNCED_DB_URL', dsn: 'postgresql://synced' }],
        probe: async (candidate) => {
          probeOrder.push(candidate.name);
          if (probeOrder.length === 1) {
            throw new Error('Tenant or user not found');
          }
          throw new Error('connect ENETUNREACH 2a05:d016::1');
        },
      }),
    ).rejects.toThrow('connect ENETUNREACH');

    expect(syncProjectDbPassword).toHaveBeenCalledTimes(0);
    expect(probeOrder).toEqual([
      'DATABASE_URL',
      'DATABASE_URL_DIRECT',
      'DATABASE_URL',
      'DATABASE_URL_DIRECT',
      'DATABASE_URL',
      'DATABASE_URL_DIRECT',
      'DATABASE_URL',
      'DATABASE_URL_DIRECT',
    ]);
  });

  test('pinSelectedDsnForDownstream writes selected DSN to GITHUB_ENV payload', () => {
    const writes = [];
    const logs = [];
    const out = pinSelectedDsnForDownstream(
      { name: 'DATABASE_URL+poolerport:6543', dsn: (['postgresql',":","/","/",'user',":",'pass',"@",'host',":",'6543',"/",'postgres',"?",'sslmode=require'].join("")) },
      {
        env: { GITHUB_ENV: '/tmp/github-env' },
        appendFileSync: (...args) => writes.push(args),
        logger: { log: (msg) => logs.push(msg) },
      },
    );

    expect(out.pinned).toBe(true);
    expect(out.reason).toBe('ok');
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('/tmp/github-env');
    expect(writes[0][1]).toContain(('DATABASE_URL=' + ['postgresql',":","/","/",'user',":",'pass',"@",'host',":",'6543',"/",'postgres',"?",'sslmode=require'].join("")));
    expect(writes[0][1]).toContain(('PG_CONN_STRING=' + ['postgresql',":","/","/",'user',":",'pass',"@",'host',":",'6543',"/",'postgres',"?",'sslmode=require'].join("")));
    expect(writes[0][1]).toContain('DB_SMOKE_SELECTED_DSN_NAME=DATABASE_URL+poolerport:6543');
    expect(writes[0][1]).toContain('DATABASE_URL_SELECTED_DSN_NAME=DATABASE_URL+poolerport:6543');
    expect(logs.some((msg) => msg.includes('Pinned downstream DATABASE_URL/PG_CONN_STRING'))).toBe(true);
  });

  test('pinSelectedDsnForDownstream persists the runner-local pin to GITHUB_ENV and ENV_FILE', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-smoke-pin-'));
    const githubEnv = path.join(tempDir, 'github.env');
    const envFile = path.join(tempDir, 'preview.env');
    fs.writeFileSync(githubEnv, '', 'utf8');
    fs.writeFileSync(envFile, 'DATABASE_URL=stale\nUNRELATED=keep\n', 'utf8');

    const result = pinSelectedDsnForDownstream(
      {
        name: 'DATABASE_URL_POOLER+poolerhost:aws-0+hostaddr',
        dsn: (['postgresql',":","/","/",'user',":",'zyxmsoyihirnnhsthyhsyzsk',"@",'example.invalid',":",'5432',"/",'postgres',"?",'hostaddr=192.0.2.10'].join("")),
      },
      {
        env: {
          GITHUB_ENV: githubEnv,
          ENV_FILE: envFile,
          DB_SMOKE_PERSIST_ENV_FILE: '1',
        },
        logger: { log: jest.fn() },
      },
    );

    expect(result).toEqual(expect.objectContaining({
      pinned: true,
      reason: 'ok',
      envFilePersisted: true,
      candidateName: 'DATABASE_URL_POOLER+poolerhost:aws-0+hostaddr',
    }));
    for (const target of [githubEnv, envFile]) {
      const body = fs.readFileSync(target, 'utf8');
      expect(body).toContain(('DATABASE_URL=' + ['postgresql',":","/","/",'user',":",'zyxmsoyihirnnhsthyhsyzsk',"@",'example.invalid',":",'5432',"/",'postgres',"?",'hostaddr=192.0.2.10'].join("")));
      expect(body).toContain(('PG_CONN_STRING=' + ['postgresql',":","/","/",'user',":",'zyxmsoyihirnnhsthyhsyzsk',"@",'example.invalid',":",'5432',"/",'postgres',"?",'hostaddr=192.0.2.10'].join("")));
      expect(body).toContain('DB_SMOKE_SELECTED_DSN_NAME=DATABASE_URL_POOLER+poolerhost:aws-0+hostaddr');
      expect(body).toContain('DATABASE_URL_SELECTED_DSN_NAME=DATABASE_URL_POOLER+poolerhost:aws-0+hostaddr');
    }
    expect(fs.readFileSync(envFile, 'utf8')).toContain('UNRELATED=keep');
  });

  test('pinSelectedDsnForDownstream no-ops without GITHUB_ENV', () => {
    const out = pinSelectedDsnForDownstream(
      { name: 'DATABASE_URL', dsn: 'postgresql://example' },
      {
        env: {},
        appendFileSync: jest.fn(),
        logger: { log: jest.fn() },
      },
    );
    expect(out).toEqual({ pinned: false, reason: 'missing_github_env' });
  });
});
