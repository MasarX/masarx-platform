const {
  resolveDbCandidate,
  resolveDbCandidatePolicy,
  resolveLabelProviderInvokeUrl,
} = require('../../../scripts/ops/ensure-label-provider');

describe('ensure-label-provider', () => {
  test('defaults preview DB candidate policy to shared-lane-safe', () => {
    expect(
      resolveDbCandidatePolicy({
        PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
      }),
    ).toBe('shared-lane-safe');
  });

  test('preserves an explicit DB candidate policy override', () => {
    expect(
      resolveDbCandidatePolicy(
        {
          PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
          DB_CONNECT_CANDIDATE_POLICY: 'default',
        },
        '',
      ),
    ).toBe('default');
    expect(
      resolveDbCandidatePolicy(
        {
          PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
        },
        'shared-lane-safe',
      ),
    ).toBe('shared-lane-safe');
  });

  test('passes env and preview-safe candidate policy through DB resolution', async () => {
    const env = {
      PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
      DB_SMOKE_TIMEOUT_MS: '5000',
      DB_SMOKE_MAX_WAIT_MS: '7000',
      DB_SMOKE_RETRY_DELAY_MS: '250',
    };
    const resolveCandidates = jest.fn(async () => [
      { name: 'DATABASE_URL_POOLER', dsn: 'postgresql://pooler' },
    ]);
    const runSmoke = jest.fn(async () => ({
      candidate: { name: 'DATABASE_URL_POOLER', dsn: 'postgresql://pooler' },
    }));

    const result = await resolveDbCandidate({
      env,
      resolveCandidates,
      runSmoke,
      logger: { warn: jest.fn(), log: jest.fn() },
    });

    expect(resolveCandidates).toHaveBeenCalledWith({
      env,
      candidatePolicy: 'shared-lane-safe',
    });
    expect(runSmoke).toHaveBeenCalledWith({
      candidates: [{ name: 'DATABASE_URL_POOLER', dsn: 'postgresql://pooler' }],
      env,
      connectionTimeoutMs: 5000,
      maxWaitMs: 7000,
      retryDelayMs: 250,
      logger: { warn: expect.any(Function), log: expect.any(Function) },
      candidatePolicy: 'shared-lane-safe',
    });
    expect(result).toEqual({ name: 'DATABASE_URL_POOLER', dsn: 'postgresql://pooler' });
  });

  test('prefers container-reachable edge URL for provider invocation', () => {
    expect(
      resolveLabelProviderInvokeUrl({
        SUPABASE_URL: 'http://127.0.0.1:57429',
        EDGE_SUPABASE_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57429',
      }),
    ).toBe('http://rvzwwjlztwwisjthghnipgjr.example.invalid:57429/functions/v1/label-renderer');
  });

  test('allows an explicit full provider invoke URL override', () => {
    expect(
      resolveLabelProviderInvokeUrl({
        SUPABASE_URL: 'https://project.supabase.co',
        EDGE_SUPABASE_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57429',
        LABEL_PROVIDER_INVOKE_URL: 'https://edge.example.test/functions/v1/label-renderer/',
      }),
    ).toBe('https://edge.example.test/functions/v1/label-renderer');
  });
});
