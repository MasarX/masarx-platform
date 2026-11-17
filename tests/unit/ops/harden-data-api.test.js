const {
  buildLegacyProbeCandidates,
  createPostgrestConfigMismatchTimeoutError,
  findWorkingProbeCandidate,
  isMissingPostgrestConfigError,
  isPreviewRuntime,
  isPreviewRuntimeContractReady,
  isRetryableMgmtApiError,
  isTransientPropagationFailure,
  postgrestConfigMatches,
  probeInvalidSchema,
  redactPostgrestConfig,
  safeBaseUrl,
  shouldSkipPostgrestMgmtConfigHardening,
  waitForDesiredPostgrestConfig,
  withMgmtApiRetry,
} = require('../../../scripts/ops/workspace/harden-data-api');

describe('workspace/harden-data-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('safeBaseUrl strips trailing slashes', () => {
    expect(safeBaseUrl('https://example.supabase.co/')).toBe('https://example.supabase.co');
    expect(safeBaseUrl('https://example.supabase.co///')).toBe('https://example.supabase.co');
  });

  test('redactPostgrestConfig omits jwt_secret', () => {
    const cfg = {
      db_schema: 'public,graphql_public',
      db_extra_search_path: 'public, extensions',
      max_rows: 1000,
      db_pool: null,
      jwt_secret: 'should-not-leak',
    };
    const redacted = redactPostgrestConfig(cfg);
    expect(redacted).toEqual({
      db_schema: 'public,graphql_public',
      db_extra_search_path: 'public, extensions',
      max_rows: 1000,
      db_pool: null,
    });
    expect(redacted.jwt_secret).toBeUndefined();
  });

  test('postgrestConfigMatches requires api-only exposure and extensions-only search path', () => {
    expect(
      postgrestConfigMatches(
        { db_schema: 'api', db_extra_search_path: 'extensions' },
        { db_schema: 'api', db_extra_search_path: 'extensions' },
      ),
    ).toBe(true);
    expect(
      postgrestConfigMatches(
        { db_schema: 'public,graphql_public', db_extra_search_path: 'public, extensions' },
        { db_schema: 'api', db_extra_search_path: 'extensions' },
      ),
    ).toBe(false);
  });

  test('isPreviewRuntime honors PREVIEW_MODE and preview aliases', () => {
    expect(isPreviewRuntime({})).toBe(false);
    expect(isPreviewRuntime({ PREVIEW_MODE: '1' })).toBe(true);
    expect(isPreviewRuntime({ CI_PREVIEW: 'true' })).toBe(true);
    expect(isPreviewRuntime({ PREVIEW_PROJECT_REF: 'wk-123' })).toBe(true);
    expect(isPreviewRuntime({ PREVIEW_SUPABASE_URL: 'https://wk.supabase.co' })).toBe(true);
    expect(isPreviewRuntime({ PREVIEW_SUPABASE_ACCESS_TOKEN: 'tok' })).toBe(true);
  });

  test('isPreviewRuntimeContractReady requires preview runtime, DB, JWT, and REST readiness', () => {
    expect(isPreviewRuntimeContractReady({})).toBe(false);
    expect(isPreviewRuntimeContractReady({
      PREVIEW_RUNTIME_READY: '1',
      PREVIEW_RUNTIME_DB_READY: '1',
      PREVIEW_RUNTIME_JWT_READY: '1',
      PREVIEW_RUNTIME_REST_READY: '1',
    })).toBe(true);
    expect(isPreviewRuntimeContractReady({
      PREVIEW_RUNTIME_READY: '1',
      PREVIEW_RUNTIME_DB_READY: '1',
      PREVIEW_RUNTIME_JWT_READY: '0',
      PREVIEW_RUNTIME_REST_READY: '1',
    })).toBe(false);
  });

  test('isRetryableMgmtApiError marks transient/status errors as retryable', () => {
    expect(isRetryableMgmtApiError({ status: 401 })).toBe(true);
    expect(isRetryableMgmtApiError({ status: 429 })).toBe(true);
    expect(isRetryableMgmtApiError({ status: 503 })).toBe(true);
    expect(isRetryableMgmtApiError({ status: 400 })).toBe(false);
    expect(isRetryableMgmtApiError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableMgmtApiError(new Error('socket hang up'))).toBe(true);
  });

  test('isTransientPropagationFailure classifies preview transient timeout details', () => {
    expect(isTransientPropagationFailure({
      last: 'rest error=fetch failed',
    })).toBe(true);
    expect(isTransientPropagationFailure({
      message: 'Timed out waiting for PostgREST to enforce api-only exposed schemas. Last: rest status=503 code=PGRST002',
    })).toBe(true);
    expect(isTransientPropagationFailure({
      message: 'Timed out waiting for PostgREST to enforce api-only exposed schemas. Last: rest status=401 code=PGRST301',
    })).toBe(false);
  });

  test('isMissingPostgrestConfigError detects preview 404 contract gap', () => {
    expect(
      isMissingPostgrestConfigError({
        status: 404,
        message: 'HTTP 404 GET /v1/projects/ref/postgrest: Postgres config not found',
      }),
    ).toBe(true);
    expect(
      isMissingPostgrestConfigError({
        status: 404,
        body: { message: 'Postgres config not found' },
      }),
    ).toBe(true);
    expect(
      isMissingPostgrestConfigError({
        status: 500,
        message: 'Postgres config not found',
      }),
    ).toBe(false);
  });

  test('shouldSkipPostgrestMgmtConfigHardening is preview-only and env-gated', () => {
    const err = {
      status: 404,
      message: 'HTTP 404 GET /v1/projects/ref/postgrest: Postgres config not found',
    };
    expect(
      shouldSkipPostgrestMgmtConfigHardening({
        err,
        env: { PREVIEW_MODE: '1' },
      }),
    ).toBe(true);
    expect(
      shouldSkipPostgrestMgmtConfigHardening({
        err,
        env: {
          PREVIEW_MODE: '1',
          DATA_API_HARDEN_ALLOW_PREVIEW_POSTGREST_CONFIG_MISSING: '0',
        },
      }),
    ).toBe(false);
    expect(
      shouldSkipPostgrestMgmtConfigHardening({
        err,
        env: {},
      }),
    ).toBe(false);
  });

  test('withMgmtApiRetry retries transient errors then succeeds', async () => {
    let calls = 0;
    const value = await withMgmtApiRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          const err = new Error('HTTP 401');
          err.status = 401;
          throw err;
        }
        return 'ok';
      },
      { timeoutMs: 5000, delayMs: 1, label: 'test' },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  test('withMgmtApiRetry fails fast for non-retryable errors', async () => {
    await expect(
      withMgmtApiRetry(
        async () => {
          const err = new Error('HTTP 400');
          err.status = 400;
          throw err;
        },
        { timeoutMs: 1000, delayMs: 1, label: 'test' },
      ),
    ).rejects.toThrow('HTTP 400');
  });

  test('waitForDesiredPostgrestConfig returns after config propagation catches up', async () => {
    const wanted = { db_schema: 'api', db_extra_search_path: 'extensions' };
    const readConfig = jest
      .fn()
      .mockResolvedValueOnce({ db_schema: 'public,graphql_public', db_extra_search_path: 'public, extensions' })
      .mockResolvedValueOnce({ db_schema: 'api', db_extra_search_path: 'extensions' });

    await expect(
      waitForDesiredPostgrestConfig({
        readConfig,
        wanted,
        timeoutMs: 50,
        delayMs: 1,
      }),
    ).resolves.toEqual({ db_schema: 'api', db_extra_search_path: 'extensions' });
    expect(readConfig).toHaveBeenCalledTimes(2);
  });

  test('waitForDesiredPostgrestConfig surfaces last stale config on timeout', async () => {
    const wanted = { db_schema: 'api', db_extra_search_path: 'extensions' };
    const stale = { db_schema: 'public,graphql_public', db_extra_search_path: 'public, extensions' };
    const readConfig = jest.fn().mockResolvedValue(stale);

    await expect(
      waitForDesiredPostgrestConfig({
        readConfig,
        wanted,
        timeoutMs: 5,
        delayMs: 1,
      }),
    ).rejects.toMatchObject({
      code: 'POSTGREST_CONFIG_MISMATCH_TIMEOUT',
      effective: stale,
      wanted,
    });
  });

  test('createPostgrestConfigMismatchTimeoutError redacts config in error payload', () => {
    const err = createPostgrestConfigMismatchTimeoutError({
      wanted: { db_schema: 'api', db_extra_search_path: 'extensions' },
      lastConfig: {
        db_schema: 'public,graphql_public',
        db_extra_search_path: 'public, extensions',
        jwt_secret: 'hidden',
      },
    });

    expect(err.code).toBe('POSTGREST_CONFIG_MISMATCH_TIMEOUT');
    expect(err.effective).toEqual({
      db_schema: 'public,graphql_public',
      db_extra_search_path: 'public, extensions',
      max_rows: null,
      db_pool: null,
    });
  });

  test('buildLegacyProbeCandidates includes api-key-only fallbacks and deduplicates entries', () => {
    const candidates = buildLegacyProbeCandidates({
      anonKey: 'anon-key',
      serviceKey: 'service-key',
    });
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ apiKey: 'anon-key', bearerToken: 'anon-key', source: 'legacy:anon/anon' }),
        expect.objectContaining({ apiKey: 'service-key', bearerToken: 'service-key', source: 'legacy:service/service' }),
        expect.objectContaining({ apiKey: 'anon-key', bearerToken: '', source: 'apikey-only:anon' }),
        expect.objectContaining({ apiKey: 'service-key', bearerToken: '', source: 'apikey-only:service' }),
      ]),
    );
    const uniquePairs = new Set(candidates.map((row) => `${row.apiKey}|${row.bearerToken}`));
    expect(uniquePairs.size).toBe(candidates.length);
  });

  test('probeInvalidSchema omits authorization header when bearer token is empty', async () => {
    global.fetch.mockResolvedValueOnce({
      status: 401,
      text: async () => JSON.stringify({ code: 'PGRST301' }),
    });

    await probeInvalidSchema({
      baseUrl: 'https://ref.supabase.co',
      apiKey: 'apikey',
      bearerToken: '',
      schema: 'public',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://ref.supabase.co/rest/v1/spatial_ref_sys?select=srid&limit=1',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.any(String) }),
      }),
    );
  });

  test('findWorkingProbeCandidate skips PGRST301 and selects first accepted candidate', async () => {
    global.fetch
      .mockResolvedValueOnce({
        status: 401,
        text: async () => JSON.stringify({ code: 'PGRST301' }),
      })
      .mockResolvedValueOnce({
        status: 406,
        text: async () => JSON.stringify({ code: 'PGRST106' }),
      });

    const selected = await findWorkingProbeCandidate({
      baseUrl: 'https://ref.supabase.co',
      candidates: [
        { apiKey: 'k1', bearerToken: 'b1', source: 'first' },
        { apiKey: 'k2', bearerToken: '', source: 'second' },
      ],
    });

    expect(selected).toEqual(expect.objectContaining({ apiKey: 'k2', source: 'second' }));
  });
});
