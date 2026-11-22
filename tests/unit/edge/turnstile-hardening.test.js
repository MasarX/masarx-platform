const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const edgeRoot = path.resolve(__dirname, '../../../supabase/functions');
const allowedOrigin = 'https://tracking.example.invalid';
const siteverifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const signupHandlers = ['driver-signup-intake', 'tenant-signup-intake'];

function setup(secret = 'fixture-secret', handlerName = 'public-shipment-tracking') {
  let handler;
  const rpc = jest.fn(async (name) => {
    switch (name) {
      case 'marketplace_public_entry_resolve_v1':
        return { data: {
          ok: true, organization_id: '11111111-2222-4333-8444-555555555555',
          organization_slug: 'fixture-org',
        }, error: null };
      case 'marketplace_compliance_policy_v1':
      case 'tenant_signup_policy_v1':
        return { data: { enabled: true, turnstile: { required: true } }, error: null };
      case 'tenant_signup_request_create_v1':
        return { data: { ok: true, status: 'under_review' }, error: null };
      default:
        throw new Error('Unexpected fixture RPC: ' + name);
    }
  });
  const from = jest.fn();
  const createClient = jest.fn(() => ({ rpc, from }));
  const fetch = jest.fn();
  const log = jest.fn();
  const logError = jest.fn(log);
  const logWarn = jest.fn(log);
  const env = {
    EDGE_SUPABASE_URL: "https://data.example.invalid",
    EDGE_SUPABASE_SECRET_KEY: "fixture-service-key",
    PUBLIC_TRACKING_CORS_ALLOW_ORIGINS: allowedOrigin,
    MARKETING_CORS_ALLOW_ORIGINS: allowedOrigin,
    MARKETING_TURNSTILE_SECRET_KEY: secret,
    MARKETING_IP_HASH_SALT: 'fixture-marketing-salt',
    PUBLIC_TRACKING_TURNSTILE_SECRET_KEY: secret,
    PUBLIC_TRACKING_IP_HASH_SALT: "fixture-tracking-salt",
    PUBLIC_TRACKING_RPC_SCHEMA: 'fixture_tracking',
  };
  const sandbox = vm.createContext({
    Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
    Error, crypto: webcrypto, fetch, performance,
    console: { log, info: log, warn: logWarn, error: logError, debug: log, trace: log, dir: log },
    Deno: { env: { get: (key) => env[key] }, serve: (fn) => { handler = fn; } },
  });
  const modules = new Map();

  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const record = { exports: {} };
    modules.set(filename, record);
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename.replace(/\.mjs$/, '.ts'),
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const execute = vm.runInContext(`(function(require, module, exports) {\n${outputText}\n})`, sandbox, { filename });
    execute((specifier) => {
      if (specifier === 'npm:@supabase/supabase-js@2.111.0') return { createClient };
      if (!specifier.startsWith('.')) throw new Error(`Unexpected edge import: ${specifier}`);
      const local = specifier.startsWith('./_shared/') ? edgeRoot : path.dirname(filename);
      return load(path.resolve(local, specifier));
    }, record, record.exports);
    return record.exports;
  }

  load(path.join(edgeRoot, handlerName, 'index.ts'));
  return { handler, rpc, fetch };
}

function request(route = 'public-shipment-tracking/lookup', origin = allowedOrigin) {
  return new Request(`https://edge.example.invalid/functions/v1/${route}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.4',
      'x-forwarded-for': '192.0.2.8',
    },
    body: JSON.stringify({
      email: 'fixture@example.invalid', company: 'Fixture Company',
      full_name: 'Fixture Person', organization_name: 'Fixture Company', entry_key: 'fixture-entry',
      reference: 'FIXTURE-123', turnstile_token: 'fixture-token',
    }),
  });
}


let turnstile;
beforeAll(async () => {
  turnstile = await import(pathToFileURL(path.join(edgeRoot, '_shared/turnstile-local-test.mjs')).href);
});

test.each([undefined, '', '  '])('rejects a missing Siteverify hostname %p', async (hostname) => {
  expect(turnstile.turnstileHostnameFailure(hostname, allowedOrigin)).toBe('hostname_missing');
  const app = setup();
  app.fetch.mockResolvedValue(Response.json({ success: true, hostname }));
  const response = await app.handler(request());
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ ok: false, error: { code: 'turnstile_invalid' } });
  expect(app.rpc).not.toHaveBeenCalled();
});

test.each(['', 'not an origin', 'file:///fixture'])('rejects an origin without a usable hostname %p', (origin) => {
  expect(turnstile.turnstileHostnameFailure('tracking.example.invalid', origin)).toBe('origin_hostname_missing');
});

test.each(['1', '2', '3', null])('refuses nonlocal test material %p in both verification flows', async (prefix) => {
  const secret = prefix ? `${prefix}x${'0'.repeat(31)}AA` : 'fixture-secret';
  const result = () => Response.json({
    success: true,
    hostname: 'tracking.example.invalid',
    metadata: { result_with_testing_key: !prefix },
  });
  const fetchImpl = jest.fn(result);
  await expect(turnstile.verifyMarketingTurnstile({
    token: 'fixture-token', secret, localContext: false, fetchImpl,
  })).rejects.toThrow('turnstile_testing_key_refused');
  expect(fetchImpl).toHaveBeenCalledTimes(prefix ? 0 : 1);

  const app = setup(secret);
  app.fetch.mockImplementation(result);
  const response = await app.handler(request());
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ ok: false, error: { code: 'turnstile_verify_failed' } });
  expect(app.fetch).toHaveBeenCalledTimes(prefix ? 0 : 1);
  expect(app.rpc).not.toHaveBeenCalled();
});

test.each([
  ['public-shipment-tracking', 'public-shipment-tracking/lookup'],
  ['marketing-lead-intake', 'marketing-lead-intake'],
])('%s returns a fixed 502 body when Siteverify throws', async (name, route) => {
  const app = setup('fixture-secret', name);
  app.fetch.mockRejectedValue(new Error('private fixture detail'));
  const response = await app.handler(request(route));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ ok: false, error: { code: 'turnstile_verify_failed' } });
  expect(app.rpc).not.toHaveBeenCalled();
});

describe.each(signupHandlers)('%s Turnstile admission', (name) => {
  test('rejects an empty Siteverify hostname before persistence', async () => {
    const app = setup('fixture-secret', name);
    app.fetch.mockResolvedValueOnce(Response.json({ success: true, hostname: '' }));

    const response = await app.handler(request(name));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'turnstile_invalid' } });
    expect(app.fetch).toHaveBeenCalledWith(siteverifyUrl, expect.any(Object));
    expect(app.rpc.mock.calls.every(([rpcName]) => !rpcName.endsWith('_create_v1'))).toBe(true);
  });

  test.each(['secret', 'metadata'])('refuses nonlocal testing %s', async (material) => {
    const testSecret = material === 'secret';
    const secret = testSecret ? `1x${'0'.repeat(31)}AA` : 'fixture-secret';
    const app = setup(secret, name);
    app.fetch.mockResolvedValueOnce(Response.json({
      success: true, hostname: 'tracking.example.invalid',
      metadata: { result_with_testing_key: !testSecret },
    }));

    const response = await app.handler(request(name));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'turnstile_verify_failed' } });
    expect(app.fetch).toHaveBeenCalledTimes(testSecret ? 0 : 1);
    expect(app.rpc.mock.calls.every(([rpcName]) => !rpcName.endsWith('_create_v1'))).toBe(true);
  });

  test('returns only the fixed 502 body when Siteverify throws', async () => {
    const app = setup('fixture-secret', name);
    app.fetch.mockRejectedValueOnce(new Error('private fixture detail'));

    const response = await app.handler(request(name));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'turnstile_verify_failed' } });
    expect(app.fetch).toHaveBeenCalledWith(siteverifyUrl, expect.any(Object));
    expect(app.rpc.mock.calls.every(([rpcName]) => !rpcName.endsWith('_create_v1'))).toBe(true);
  });
});

test.each(['marketing-lead-intake', 'tenant-signup-intake'])(
  '%s omits Siteverify error codes from the successful intake body', async (name) => {
    const app = setup('fixture-secret', name);
    app.fetch.mockResolvedValueOnce(Response.json({
      success: true, hostname: 'tracking.example.invalid',
      'error-codes': ['fixture-provider-detail'],
    }));
    if (name === 'marketing-lead-intake') app.fetch.mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await app.handler(request(name));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true });
    expect(body).not.toHaveProperty('turnstile_error_codes');
    expect(app.fetch).toHaveBeenCalledWith(siteverifyUrl, expect.any(Object));
  },
);
