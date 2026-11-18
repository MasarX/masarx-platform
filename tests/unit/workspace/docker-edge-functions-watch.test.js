const {
  probeEdgeFunction,
  resolveBaseUrl,
} = require('../../../scripts/ops/workspace/docker-edge-functions-watch');

describe('workspace docker edge functions watcher', () => {
  test('keeps the shared host URL default for callers outside the backend network', () => {
    expect(resolveBaseUrl({}, {
      EDGE_SUPABASE_URL: 'http://xqpjiyiztkhwlxxwurxilvmo.example.invalid:8000',
      SUPABASE_FUNCTIONS_INTERNAL_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:56509/functions/v1',
      SUPABASE_URL: 'http://127.0.0.1:56509',
    })).toBe('http://rvzwwjlztwwisjthghnipgjr.example.invalid:56509/functions/v1');
  });

  test('allows the watcher command to select the canonical network URL explicitly', () => {
    expect(resolveBaseUrl({
      url: 'http://explicit.invalid/functions/v1/',
    }, {
      EDGE_SUPABASE_URL: 'http://xqpjiyiztkhwlxxwurxilvmo.example.invalid:8000',
    })).toBe('http://explicit.invalid/functions/v1');
  });

  test('retains the host fallback when no canonical URL is supplied', () => {
    expect(resolveBaseUrl({}, {
      SUPABASE_URL: 'http://127.0.0.1:56509',
    })).toBe('http://127.0.0.1:56509/functions/v1');
  });

  test('probes readiness without forwarding available credentials', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ status: 401 }));
    try {
      await expect(probeEdgeFunction('http://xqpjiyiztkhwlxxwurxilvmo.example.invalid:8000/functions/v1/metrics-echo-test', {
        EDGE_FUNCTION_HEALTH_TOKEN: 'health-token',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-token',
        EDGE_DB_JWT: 'edge-db-jwt',
      })).resolves.toMatchObject({ ok: true, status: 401 });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://xqpjiyiztkhwlxxwurxilvmo.example.invalid:8000/functions/v1/metrics-echo-test',
        { method: 'GET' },
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
