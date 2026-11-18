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

  test.each([
    [{
      LABEL_PROVIDER_INVOKE_URL: ' https://provider.test/custom-renderer/// ',
      LABEL_RENDERER_INVOKE_URL: 'https://renderer.test/ignored',
      EDGE_SUPABASE_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57429',
      SUPABASE_URL: 'https://public.test',
    }, 'https://provider.test/custom-renderer'],
    [{
      LABEL_PROVIDER_INVOKE_URL: ' ',
      LABEL_RENDERER_INVOKE_URL: ' https://renderer.test/functions/v1/label-renderer/ ',
      EDGE_SUPABASE_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57429',
      SUPABASE_URL: 'https://public.test',
    }, 'https://renderer.test/functions/v1/label-renderer'],
    [{
      EDGE_SUPABASE_URL: ' http://rvzwwjlztwwisjthghnipgjr.example.invalid:57429/// ',
      SUPABASE_URL: 'http://127.0.0.1:57429',
    }, 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57429/functions/v1/label-renderer'],
    [{ SUPABASE_URL: ' https://project.supabase.co/// ' }, 'https://project.supabase.co/functions/v1/label-renderer'],
    [{ EDGE_SUPABASE_URL: 'http://[::1]:57429' }, 'http://[::1]:57429/functions/v1/label-renderer'],
    [{ LABEL_PROVIDER_INVOKE_URL: 'http://edge.test/custom' }, 'http://edge.test/custom'],
    [{ LABEL_RENDERER_INVOKE_URL: 'https://renderer.test/custom' }, 'https://renderer.test/custom'],
    [{ LABEL_PROVIDER_INVOKE_URL: ' ', EDGE_SUPABASE_URL: '', SUPABASE_URL: 'https://public.test' }, 'https://public.test/functions/v1/label-renderer'],
    [{}, ''],
  ])('resolves invoke URL precedence and trailing slashes: %p', (env, expected) => {
    expect(resolveLabelProviderInvokeUrl(env)).toBe(expected);
  });

  test.each([
    'LABEL_PROVIDER_INVOKE_URL',
    'LABEL_RENDERER_INVOKE_URL',
    'EDGE_SUPABASE_URL',
    'SUPABASE_URL',
  ])('rejects an invalid selected %s instead of falling back', (key) => {
    expect(() => resolveLabelProviderInvokeUrl({
      SUPABASE_URL: 'https://public.test',
      [key]: 'not-a-url',
    })).toThrow(`${key} must be an absolute HTTP(S) URL without credentials, query, or fragment`);
  });

  test.each([
    '/functions/v1/label-renderer',
    '//edge.test/functions/v1/label-renderer',
    'https:edge.test/functions/v1/label-renderer',
    'ftp://edge.test/functions/v1/label-renderer',
    'http://',
    'https://edge.test:99999/functions/v1/label-renderer',
    (['https',":","/","/",'user',":",'synthetic-password',"@",'edge.test',"/",'functions',"/",'v1',"/",'label-renderer'].join("")),
    'https://edge.test/functions/v1/label-renderer?token=synthetic-query',
    'https://edge.test/functions/v1/label-renderer#fragment',
    'https://edge.test/functions/v1/label-renderer?',
    'https://edge.test/functions/v1/label-renderer#',
    'https://edge.test/a\\b',
    'https://edge.test/a b',
    'https://edge.test/a\nb',
  ])('rejects malformed or decorated URLs without exposing the configured value: %p', (value) => {
    expect(() => resolveLabelProviderInvokeUrl({ LABEL_PROVIDER_INVOKE_URL: value }))
      .toThrow(/^LABEL_PROVIDER_INVOKE_URL must be an absolute HTTP\(S\) URL without credentials, query, or fragment$/);
  });
});
