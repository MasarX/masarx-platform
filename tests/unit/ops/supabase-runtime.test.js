const {
  normalizeSupabaseUrl,
  shouldRetryJwtError,
  waitForStorageAuth,
  resolveJwtPropagationOptions,
} = require('../../../scripts/ops/workspace/supabase-runtime');

describe('supabase-runtime helpers', () => {
  test('normalizeSupabaseUrl trims and strips trailing slashes', () => {
    expect(normalizeSupabaseUrl(' https://example.supabase.co/ ')).toBe('https://example.supabase.co');
    expect(normalizeSupabaseUrl('https://example.supabase.co////')).toBe('https://example.supabase.co');
  });

  test('shouldRetryJwtError detects signature failures', () => {
    expect(shouldRetryJwtError(403, { message: 'signature verification failed' })).toBe(true);
    expect(shouldRetryJwtError(400, { message: 'signature verification failed' })).toBe(true);
    expect(shouldRetryJwtError(400, { message: 'Missing tenant config for tenant abc' })).toBe(true);
    expect(shouldRetryJwtError(403, { message: 'permission denied' })).toBe(false);
    expect(shouldRetryJwtError(500, { message: 'internal server error' })).toBe(false);
  });

  test('resolveJwtPropagationOptions honors env overrides', () => {
    const opts = resolveJwtPropagationOptions({
      SUPABASE_JWT_PROPAGATION_TIMEOUT_MS: '120000',
      SUPABASE_JWT_PROPAGATION_INTERVAL_MS: '2500',
    });
    expect(opts).toEqual({ timeoutMs: 120000, intervalMs: 2500 });
  });

  test('waitForStorageAuth retries on signature mismatch before success', async () => {
    const originalFetch = global.fetch;
    const originalLog = console.log;
    console.log = jest.fn();
    const responses = [
      { ok: false, status: 403, body: { message: 'signature verification failed' } },
      { ok: true, status: 200, body: [] },
    ];
    global.fetch = jest.fn(async (_url, init) => {
      expect(init.headers.apikey).toBe('service-key');
      expect(init.headers.authorization).toBe('Bearer service-key');
      const next = responses.shift();
      return {
        ok: next.ok,
        status: next.status,
        text: async () => JSON.stringify(next.body),
      };
    });
    try {
      const res = await waitForStorageAuth({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        timeoutMs: 1000,
        intervalMs: 1,
      });

      expect(res.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      global.fetch = originalFetch;
      console.log = originalLog;
    }
  });
});
