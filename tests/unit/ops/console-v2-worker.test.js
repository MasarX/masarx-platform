const { buildSecurityHeaders } = require('../../../apps/shared/security-headers');
const { dispatcher } = require('../../../config/dev/sweep-roles.json');

const origin = 'https://console.example.test';
const placeholder = 'nonce-placeholder';
let worker;
let jsonRequest;
let verifyDispatcher;
let env;

beforeAll(async () => {
  ({ default: worker } = await import('../../../tooling/apps/console-v2-worker/index.mjs'));
  ({ jsonRequest, verifyDispatcher } = await import('../../../scripts/deploy/console-v2-dev.mjs'));
});

beforeEach(() => {
  env = {
    DEV_ORIGIN: origin,
    ASSETS: { fetch: jest.fn() },
    NONCE_PLACEHOLDER: placeholder,
    SUPABASE_URL: 'https://data.example.test',
    TRUSTED_EXTERNAL_DATA_ORIGINS: 'https://images.example.test',
    MAP_TILE_ORIGINS: 'https://tiles.example.test',
    FONT_STYLESHEET_ORIGINS: 'https://styles.example.test',
    FONT_ASSET_ORIGINS: 'https://fonts.example.test',
  };
});

test('rejects requests from a different origin before fetching assets', async () => {
  const response = await worker.fetch(new Request('https://other.example.test/'), env);
  expect(response.status).toBe(404);
  expect(env.ASSETS.fetch).not.toHaveBeenCalled();
});

test('advertises the allowed methods without fetching assets for other methods', async () => {
  const response = await worker.fetch(new Request(origin, { method: 'POST' }), env);
  expect(response.status).toBe(405);
  expect(response.headers.get('Allow')).toBe('GET, HEAD');
  expect(env.ASSETS.fetch).not.toHaveBeenCalled();
});

test('falls back to the index for a missing document and forwards HEAD', async () => {
  const index = new Response(null, { headers: { 'Content-Type': 'application/octet-stream' } });
  env.ASSETS.fetch.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(index);
  const response = await worker.fetch(new Request(`${origin}/shipments`, {
    method: 'HEAD',
    headers: { Accept: 'text/html' },
  }), env);

  expect(response).toBe(index);
  expect(env.ASSETS.fetch.mock.calls.map(([request]) => [new URL(request.url).pathname, request.method]))
    .toEqual([['/shipments', 'HEAD'], ['/index.html', 'HEAD']]);
});

test.each(['/assets/missing.js', '/__deploy/missing.json'])('preserves the 404 for %s', async (path) => {
  const missing = new Response(null, { status: 404 });
  env.ASSETS.fetch.mockResolvedValueOnce(missing);
  const response = await worker.fetch(new Request(`${origin}${path}`, {
    headers: { Accept: 'text/html' },
  }), env);

  expect(response).toBe(missing);
  expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
});

test('returns non-HTML assets unchanged', async () => {
  const asset = new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  env.ASSETS.fetch.mockResolvedValueOnce(asset);
  expect(await worker.fetch(new Request(`${origin}/__deploy/marker.json`), env)).toBe(asset);
  expect(await asset.json()).toEqual({ ok: true });
});

test('rewrites HTML metadata and replaces only placeholder nonces on each response', async () => {
  const assetHeaders = {
    'Content-Type': 'text/html',
    'Cache-Control': 'public, max-age=3600',
    ETag: '"asset"',
    'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
    'Content-Length': '18',
  };
  env.ASSETS.fetch.mockImplementation(async () => new Response('<!doctype html>', { headers: assetHeaders }));

  const on = jest.fn();
  const rewritten = [];
  const original = global.HTMLRewriter;
  global.HTMLRewriter = class {
    on(selector, handler) {
      on(selector, handler);
      this.handler = handler;
      return this;
    }

    transform(response) {
      const match = { getAttribute: () => placeholder, setAttribute: jest.fn() };
      const other = { getAttribute: () => 'other-nonce', setAttribute: jest.fn() };
      this.handler.element(match);
      this.handler.element(other);
      rewritten.push({ match, other });
      return response;
    }
  };
  try {
    const request = new Request(origin);
    const responses = [await worker.fetch(request, env), await worker.fetch(request, env)];
    expect(on).toHaveBeenCalledTimes(2);
    const nonces = responses.map((response, index) => {
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      for (const header of ['ETag', 'Last-Modified', 'Content-Length']) {
        expect(response.headers.has(header)).toBe(false);
      }
      expect(on).toHaveBeenNthCalledWith(index + 1, '[nonce]', { element: expect.any(Function) });
      const { match, other } = rewritten[index];
      const nonce = /'nonce-([^']+)'/.exec(response.headers.get('Content-Security-Policy'))?.[1];
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
      expect(match.setAttribute).toHaveBeenCalledTimes(1);
      expect(match.setAttribute).toHaveBeenCalledWith('nonce', nonce);
      expect(other.setAttribute).not.toHaveBeenCalled();
      for (const { key, value } of buildSecurityHeaders({
        nonce,
        nodeEnv: 'production',
        supabaseUrl: env.SUPABASE_URL,
        trustedExternalDataOrigins: env.TRUSTED_EXTERNAL_DATA_ORIGINS,
        mapTileOrigins: env.MAP_TILE_ORIGINS,
        fontStylesheetOrigins: env.FONT_STYLESHEET_ORIGINS,
        fontAssetOrigins: env.FONT_ASSET_ORIGINS,
        sameOriginWorkers: true,
      })) {
        expect(response.headers.get(key)).toBe(value);
      }
      return nonce;
    });
    expect(nonces[0]).not.toBe(nonces[1]);
  } finally {
    if (original === undefined) delete global.HTMLRewriter;
    else global.HTMLRewriter = original;
  }
});

const sweepSession = {
  access_token: 'synthetic-session',
  user: { role: 'authenticated', app_metadata: { dev_design_sweep: 'dispatcher' } },
};
const dispatcherPolicy = {
  allowed: true,
  scope_type: dispatcher.scope,
  role_keys: ['dispatcher'],
  granted_capabilities: dispatcher.required,
};

test('accepts a synthetic dispatcher with only the configured read permissions', async () => {
  const readPolicy = jest.fn().mockResolvedValue({ ok: true, eval: dispatcherPolicy });
  await expect(verifyDispatcher(sweepSession, readPolicy)).resolves.toBeUndefined();
  expect(readPolicy).toHaveBeenCalledWith(sweepSession.access_token);
});

test.each([
  ['another role', { role_keys: ['finance_viewer'] }],
  ['an additional role', { role_keys: ['dispatcher', 'finance_viewer'] }],
  ['a missing role claim', { role_keys: undefined }],
  ['a wider scope', { scope_type: 'global' }],
  ['a wider permission', { granted_capabilities: [...dispatcher.required, 'shipments.update'] }],
])('rejects a dispatcher session with %s', async (_label, overrides) => {
  const readPolicy = jest.fn().mockResolvedValue({ ok: true, eval: { ...dispatcherPolicy, ...overrides } });
  await expect(verifyDispatcher(sweepSession, readPolicy)).rejects.toThrow('DEV_DISPATCHER_UNVERIFIED');
});

test.each([undefined, 'finance_viewer'])('rejects a session with sweep marker %s before reading policy', async marker => {
  const session = { ...sweepSession, user: { ...sweepSession.user, app_metadata: { dev_design_sweep: marker } } };
  const readPolicy = jest.fn();
  await expect(verifyDispatcher(session, readPolicy)).rejects.toThrow('DEV_DISPATCHER_UNVERIFIED');
  expect(readPolicy).not.toHaveBeenCalled();
});

test.each([429, 500, 503])('retries a network failure and HTTP %i with increasing delays and a fresh timeout', async status => {
  const networkError = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  const fetch = jest.spyOn(global, 'fetch').mockRejectedValueOnce(networkError)
    .mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(Response.json({ ok: true }));
  const wait = jest.fn();
  try {
    await expect(jsonRequest(origin, {}, 'Readback', wait)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[5000], [15000]]);
    expect(new Set(fetch.mock.calls.map(([, options]) => options.signal)).size).toBe(3);
  } finally {
    fetch.mockRestore();
  }
});

test.each([[503, 3], [403, 1]])('stops after HTTP %i returns %i time(s)', async (status, attempts) => {
  const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(null, { status }));
  const wait = jest.fn();
  try {
    await expect(jsonRequest(origin, {}, 'Readback', wait)).rejects.toThrow(`Readback failed with HTTP ${status}.`);
    expect(fetch).toHaveBeenCalledTimes(attempts);
    expect(wait).toHaveBeenCalledTimes(attempts - 1);
  } finally {
    fetch.mockRestore();
  }
});
