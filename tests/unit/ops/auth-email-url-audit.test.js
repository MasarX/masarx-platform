const path = require('path');
const {
  isRetryableAuthConfigReadError,
  parseArgs,
  parsePositiveMs,
  readProjectAuthConfigWithRetries,
  resolveReadRetryOptions,
  resolveProjectRef,
  resolveSummaryPath,
} = require('../../../scripts/ops/audit/auth-email-url-audit');

describe('auth-email-url-audit script helpers', () => {
  test('parseArgs handles json flag and aliases', () => {
    const parsed = parseArgs([
      '--environment',
      'dev',
      '--af38b526-f5c1-468d-88fb-86677fbe872a=proj-1',
      '--summary-out',
      'tmp/audit.json',
      '--json',
    ]);

    expect(parsed.environment).toBe('dev');
    expect(parsed['af38b526-f5c1-468d-88fb-86677fbe872a']).toBe('proj-1');
    expect(parsed.summary_out).toBe('tmp/audit.json');
    expect(parsed.json).toBe(true);
  });

  test('resolveProjectRef resolves from args or env', () => {
    expect(resolveProjectRef({ project_ref: 'from-arg' }, {})).toBe('from-arg');
    expect(resolveProjectRef({}, { SUPABASE_PROJECT_ID: 'from-env' })).toBe('from-env');
    expect(() => resolveProjectRef({}, {})).toThrow('Missing SUPABASE_PROJECT_ID');
  });

  test('resolveSummaryPath uses default path when unset', () => {
    const out = resolveSummaryPath({});
    expect(out.endsWith(path.join('tmp', 'auth-email-url-audit-summary.json'))).toBe(true);
  });

  test('parsePositiveMs falls back for invalid values', () => {
    expect(parsePositiveMs('1500', 10)).toBe(1500);
    expect(parsePositiveMs('-1', 10)).toBe(10);
    expect(parsePositiveMs('abc', 10)).toBe(10);
  });

  test('resolveReadRetryOptions reads args and env overrides', () => {
    expect(
      resolveReadRetryOptions(
        { read_max_wait_ms: '9000', read_retry_delay_ms: '2000' },
        {},
      ),
    ).toEqual({
      maxWaitMs: 9000,
      retryDelayMs: 2000,
    });

    expect(
      resolveReadRetryOptions(
        {},
        {
          AUTH_EMAIL_URL_AUDIT_READ_MAX_WAIT_MS: '8000',
          AUTH_EMAIL_URL_AUDIT_READ_RETRY_DELAY_MS: '12000',
        },
      ),
    ).toEqual({
      maxWaitMs: 8000,
      retryDelayMs: 8000,
    });
  });

  test('isRetryableAuthConfigReadError accepts transient network-style failures', () => {
    expect(isRetryableAuthConfigReadError(new Error('Unable to fetch project auth config (fetch failed)'))).toBe(true);
    expect(isRetryableAuthConfigReadError({ status: 503, message: 'HTTP 503' })).toBe(true);
    expect(isRetryableAuthConfigReadError({ status: 401, message: 'unauthorized' })).toBe(false);
  });

  test('readProjectAuthConfigWithRetries retries transient failures until success', async () => {
    const fetchAuthConfig = jest
      .fn()
      .mockRejectedValueOnce(new Error('Unable to fetch project auth config (fetch failed)'))
      .mockResolvedValueOnce({ site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback' });
    const sleepFn = jest.fn().mockResolvedValue();

    await expect(
      readProjectAuthConfigWithRetries({
        projectRef: 'proj-ref',
        token: 'token',
        maxWaitMs: 5000,
        retryDelayMs: 100,
        fetchAuthConfig,
        sleepFn,
      }),
    ).resolves.toEqual({
      current: { site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback' },
      attempts: 2,
      retried: true,
    });

    expect(fetchAuthConfig).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(100);
  });

  test('readProjectAuthConfigWithRetries fails closed for non-retryable errors', async () => {
    const fetchAuthConfig = jest.fn().mockRejectedValue({ status: 401, message: 'unauthorized' });

    await expect(
      readProjectAuthConfigWithRetries({
        projectRef: 'proj-ref',
        token: 'token',
        maxWaitMs: 5000,
        retryDelayMs: 100,
        fetchAuthConfig,
      }),
    ).rejects.toEqual({ status: 401, message: 'unauthorized' });

    expect(fetchAuthConfig).toHaveBeenCalledTimes(1);
  });
});

