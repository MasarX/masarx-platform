const { buildSecurityHeaders } = require('../../../apps/shared/security-headers');

const origin = 'https://console.example.test';
const placeholder = 'nonce-placeholder';
let worker;
let env;

beforeAll(async () => {
  ({ default: worker } = await import('../../../tooling/apps/console-v2-worker/index.mjs'));
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
