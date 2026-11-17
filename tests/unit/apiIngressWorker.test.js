const path = require('path');
const { pathToFileURL } = require('url');

const loadWorkerModule = async () => {
  const modulePath = path.join(
    __dirname,
    '..',
    '..',
    'tooling',
    'apps',
    'api-ingress-worker',
    'src',
    'index.mjs'
  );
  return import(pathToFileURL(modulePath).href);
};

describe('api-ingress-worker resolveIngress', () => {
  let resolveIngress;
  let workerFetch;

  beforeAll(async () => {
    const mod = await loadWorkerModule();
    resolveIngress = mod.resolveIngress;
    workerFetch = mod.default.fetch;
  });

  const baseEnv = () => ({
    UPSTREAM_ORIGIN: 'https://upstream.example',
    REWRITE_RULES_JSON: JSON.stringify([
      { from: '/v1/webhook', to: '/functions/v1/webhook-receiver', match: 'exact', requireToken: true },
      { from: '/api/', to: '/functions/v1/api-gateway/api/', match: 'prefix', requireToken: true },
      { from: '/v1', to: '/functions/v1', match: 'prefix', requireToken: false },
    ]),
  });

  test('serves unauthenticated GET /healthz with trace headers', async () => {
    const env = baseEnv();
    const res = await workerFetch(new Request('https://vomhkplympywspxymnstltsw.example.invalid/healthz', { method: 'GET' }), env);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toMatch(/application\/json/i);
    expect(String(res.headers.get('x-correlation-id') || '')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(String(res.headers.get('traceparent') || '')).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i
    );

    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      service: 'masarx-api-ingress-worker',
    });
  });

  test('serves unauthenticated HEAD /healthz without body', async () => {
    const env = baseEnv();
    const res = await workerFetch(new Request('https://vomhkplympywspxymnstltsw.example.invalid/healthz', { method: 'HEAD' }), env);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(String(res.headers.get('x-correlation-id') || '')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(await res.text()).toBe('');
  });

  test('strips /t/<token> from path and forwards token as x-webhook-token', async () => {
    const env = baseEnv();
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/t/pathToken/v1/webhook?x=1', { method: 'GET' });
    const { response, upstreamRequest } = resolveIngress(req, env);

    expect(response).toBeUndefined();
    expect(upstreamRequest.url).toBe('https://upstream.example/functions/v1/webhook-receiver?x=1');
    expect(upstreamRequest.headers.get('x-webhook-token')).toBe('pathToken');
    expect(upstreamRequest.headers.get('x-masarx-auth-source')).toBe('path');
    expect(String(upstreamRequest.headers.get('x-correlation-id') || '')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(String(upstreamRequest.headers.get('traceparent') || '')).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i
    );
    expect(upstreamRequest.url.includes('/t/pathToken')).toBe(false);
  });

  test('derives x-correlation-id from traceparent when no valid correlation header exists', () => {
    const env = baseEnv();
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/v1/webhook', {
      method: 'GET',
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });
    const { response, upstreamRequest } = resolveIngress(req, env);

    expect(response).toBeInstanceOf(Response);
    // Missing token for /v1/webhook is an auth failure but should still be traceable.
    expect(response.status).toBe(401);
    expect(response.headers.get('x-correlation-id')).toBe('4bf92f35-77b3-4da6-a3ce-929d0e0e4736');
    expect(String(response.headers.get('traceparent') || '')).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/i
    );

    // When resolveIngress short-circuits with a response, upstreamRequest is undefined.
    expect(upstreamRequest).toBeUndefined();
  });

  test('extracts token from authorization bearer header and preserves authorization', () => {
    const env = baseEnv();
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/v1/webhook', {
      method: 'GET',
      headers: { authorization: 'Bearer bearerTok' },
    });
    const { response, upstreamRequest } = resolveIngress(req, env);

    expect(response).toBeUndefined();
    expect(upstreamRequest.url).toBe('https://upstream.example/functions/v1/webhook-receiver');
    expect(upstreamRequest.headers.get('authorization')).toBe('Bearer bearerTok');
    expect(upstreamRequest.headers.get('x-webhook-token')).toBeNull();
    expect(upstreamRequest.headers.get('x-masarx-auth-source')).toBe('authorization');
  });

  test('path token takes precedence over header token', () => {
    const env = baseEnv();
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/t/pathWins/v1/webhook', {
      method: 'GET',
      headers: { 'x-webhook-token': 'EXAMPLE_PASSWORD' },
    });
    const { response, upstreamRequest } = resolveIngress(req, env);

    expect(response).toBeUndefined();
    expect(upstreamRequest.headers.get('x-webhook-token')).toBe('pathWins');
  });

  test('query token is rejected when ALLOW_QUERY_TOKEN=0', async () => {
    const env = baseEnv();
    env.ALLOW_QUERY_TOKEN = '0';
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/v1/webhook?token=abc&x=1', { method: 'GET' });
    const { response } = resolveIngress(req, env);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Missing token.');
  });

  test('query token is stripped from upstream URL when enabled', () => {
    const env = baseEnv();
    env.ALLOW_QUERY_TOKEN = '1';
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/v1/webhook?token=queryTok&x=1', { method: 'GET' });
    const { response, upstreamRequest } = resolveIngress(req, env);

    expect(response).toBeUndefined();
    expect(upstreamRequest.url).toBe('https://upstream.example/functions/v1/webhook-receiver?x=1');
    expect(upstreamRequest.headers.get('x-webhook-token')).toBe('queryTok');
    expect(upstreamRequest.headers.get('x-masarx-auth-source')).toBe('query');
  });

  test('fails closed when no rewrite rule matches', async () => {
    const env = baseEnv();
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/nope', { method: 'GET' });
    const { response } = resolveIngress(req, env);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Not found.');
  });

  test('prefers exact rewrite matches over prefix matches', () => {
    const env = baseEnv();
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/v1/webhook', {
      method: 'GET',
      headers: { 'x-webhook-token': 'token' },
    });
    const { response, upstreamRequest } = resolveIngress(req, env);

    expect(response).toBeUndefined();
    expect(upstreamRequest.url).toBe('https://upstream.example/functions/v1/webhook-receiver');
  });

  test('adds CORS headers to jsonError responses for allowed origins', async () => {
    const env = baseEnv();
    env.CORS_ALLOW_ORIGIN = 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid';
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/v1/webhook', {
      method: 'GET',
      headers: { origin: 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid' },
    });

    const res = await workerFetch(req, env);
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid');
    expect(res.headers.get('vary')).toBe('origin');
  });

  test('handles OPTIONS CORS preflight for allowed origins', async () => {
    const env = baseEnv();
    env.CORS_ALLOW_ORIGIN = 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid';
    const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/v1/webhook', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });

    const res = await workerFetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type,authorization');
  });

  test('adds CORS headers to upstream responses for allowed origins', async () => {
    const env = baseEnv();
    env.CORS_ALLOW_ORIGIN = 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => new Response('ok', { status: 200 }));
    try {
      const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/t/token/v1/webhook', {
        method: 'GET',
        headers: { origin: 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid' },
      });

      const res = await workerFetch(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('adds deprecation headers when token is provided via ?token=', async () => {
    const env = baseEnv();
    env.ALLOW_QUERY_TOKEN = '1';
    env.CORS_ALLOW_ORIGIN = 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => new Response('ok', { status: 200 }));
    try {
      const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/v1/webhook?token=queryTok', {
        method: 'GET',
        headers: { origin: 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid' },
      });

      const res = await workerFetch(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('deprecation')).toBe('true');
      expect(res.headers.get('x-masarx-deprecated-auth')).toBe('EXAMPLE_PASSWORD');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('adds deprecation headers when token is provided via /t/<token> path auth', async () => {
    const env = baseEnv();
    env.CORS_ALLOW_ORIGIN = 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => new Response('ok', { status: 200 }));
    try {
      const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/t/pathTok/v1/webhook', {
        method: 'GET',
        headers: { origin: 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid' },
      });

      const res = await workerFetch(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('deprecation')).toBe('true');
      expect(res.headers.get('x-masarx-deprecated-auth')).toBe('path-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
