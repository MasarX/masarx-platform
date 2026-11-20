const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createHash, webcrypto } = require('node:crypto');
const { inspect } = require('node:util');

const edgeRoot = path.resolve(__dirname, '../../../supabase/functions');
const origin = 'https://tracking.example.invalid';
const serviceUrl = 'https://data.example.invalid';
const serviceKey = 'fixture-service-key';
const verifierSecret = 'fixture-turnstile-secret';
const salt = 'fixture-tracking-salt';
const ip = '203.0.113.4';
const payload = { reference: 'FIXTURE-123', turnstile_token: '  fixture+token&value  ' };
const rpcResult = { ok: true, tracking: { status: 'in_transit' } };
const verificationRequest = [
  'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'secret=fixture-turnstile-secret&response=fixture%2Btoken%26value&remoteip=203.0.113.4',
  },
];

// Run the real handler and local imports with mocked environment and I/O.
function setup() {
  let handler;
  const rpc = jest.fn().mockResolvedValue({ data: rpcResult, error: null });
  const from = jest.fn();
  const createClient = jest.fn(() => ({ rpc, from }));
  const fetch = jest.fn();
  const log = jest.fn();
  const logError = jest.fn(log);
  const env = {
    EDGE_SUPABASE_URL: serviceUrl,
    EDGE_SUPABASE_SECRET_KEY: serviceKey,
    PUBLIC_TRACKING_CORS_ALLOW_ORIGINS: origin,
    PUBLIC_TRACKING_TURNSTILE_SECRET_KEY: verifierSecret,
    PUBLIC_TRACKING_IP_HASH_SALT: salt,
    PUBLIC_TRACKING_RPC_SCHEMA: 'fixture_tracking',
  };
  const sandbox = vm.createContext({
    Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
    Error, crypto: webcrypto, fetch,
    console: { log, info: log, warn: log, error: logError, debug: log, trace: log, dir: log },
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

  load(path.join(edgeRoot, 'public-shipment-tracking/index.ts'));
  return { handler, rpc, from, createClient, fetch, log, logError };
}

function request(body, action = 'lookup') {
  return new Request(`https://edge.example.invalid/functions/v1/public-shipment-tracking/${action}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
      'x-forwarded-for': '192.0.2.8',
    },
    body: JSON.stringify(body),
  });
}

async function expectResponse(response, log, status, body) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual(body);
  expect(text.includes(verifierSecret)).toBe(false);
  const output = inspect([...response.headers, ...log.mock.calls], { depth: null });
  for (const value of [verifierSecret, serviceKey, payload.turnstile_token.trim(), ip, 'fixture%2Btoken%26value']) {
    expect(output.includes(value)).toBe(false);
  }
  return text;
}

function expectErrorLog(log, code, message, rpc) {
  expect(log).toHaveBeenCalledTimes(1);
  const entry = JSON.parse(log.mock.calls[0][0]);
  expect([entry.level, entry.event, entry.code, entry.message, entry.rpc])
    .toEqual(['error', 'public_shipment_tracking_failed', code, message, rpc]);
}

describe('public shipment tracking siteverify', () => {
  test.each(['lookup', 'verify'])('requires a token for %s before any fetch, RPC or query', async (action) => {
    const app = setup();
    const response = await app.handler(request({ reference: 'FIXTURE-123' }, action));

    await expectResponse(response, app.log, 400, { ok: false, error: { code: 'turnstile_required' } });
    expect(app.fetch).not.toHaveBeenCalled();
    expect(app.rpc).not.toHaveBeenCalled();
    expect(app.from).not.toHaveBeenCalled();
  });

  test.each([
    ['success:false', () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }),
      ['invalid-input-response']],
    ['non-JSON HTTP 503 body', () => new Response('Service Unavailable', { status: 503 }), null],
    ['HTTP 503 with {success:true}', () => Response.json({
      success: true,
      hostname: 'tracking.example.invalid',
    }, { status: 503 }), null],
  ])('rejects %s from siteverify without reading tracking data', async (_case, upstream, errorCodes) => {
    const app = setup();
    app.fetch.mockResolvedValueOnce(upstream());
    const response = await app.handler(request(payload));

    await expectResponse(response, app.log, 400, {
      ok: false,
      error: { code: 'turnstile_required' },
      turnstile_error_codes: errorCodes,
    });
    expect(app.fetch.mock.calls).toEqual([verificationRequest]);
    expect(app.rpc).not.toHaveBeenCalled();
    expect(app.from).not.toHaveBeenCalled();
  });

  test('rejects a siteverify hostname mismatch without reading tracking data', async () => {
    const app = setup();
    app.fetch.mockResolvedValueOnce(Response.json({ success: true, hostname: 'evil.example.invalid' }));
    const response = await app.handler(request(payload));

    await expectResponse(response, app.log, 400, {
      ok: false,
      error: { code: 'turnstile_invalid' },
      turnstile_error_codes: null,
    });
    expect(app.fetch.mock.calls).toEqual([verificationRequest]);
    expect(app.rpc).not.toHaveBeenCalled();
    expect(app.from).not.toHaveBeenCalled();
  });

  test('rejects a siteverify network error without reading tracking data', async () => {
    const app = setup();
    const message = 'siteverify unavailable';
    app.fetch.mockRejectedValueOnce(new Error(
      `${message}: ${verifierSecret} ${serviceKey} ${payload.turnstile_token.trim()} ${ip} fixture%2Btoken%26value`,
    ));
    const response = await app.handler(request(payload));

    const text = await expectResponse(response, app.log, 502, {
      ok: false,
      error: { code: 'turnstile_verify_failed' },
    });
    expect(text).not.toContain(message);
    expectErrorLog(app.logError, 'turnstile_verify_failed',
      `${message}: [redacted] [redacted] [redacted] [redacted] [redacted]`);
    expect(app.fetch.mock.calls).toEqual([verificationRequest]);
    expect(app.rpc).not.toHaveBeenCalled();
    expect(app.from).not.toHaveBeenCalled();
  });

  test('logs an RPC failure without returning the RPC name or internal detail', async () => {
    const app = setup();
    const message = 'fixture internal detail';
    const rpcName = 'public_tracking_lookup_v1';
    app.fetch.mockResolvedValueOnce(Response.json({ success: true, hostname: 'tracking.example.invalid' }));
    app.rpc.mockResolvedValueOnce({ data: null, error: { message, code: 'P0001' } });
    const response = await app.handler(request(payload));

    const text = await expectResponse(response, app.log, 500, { ok: false, error: { code: 'rpc_failed' } });
    expect(text).not.toContain(message);
    expect(text).not.toContain(rpcName);
    expectErrorLog(app.logError, 'rpc_failed', message, rpcName);
    expect(app.rpc).toHaveBeenCalledTimes(1);
    expect(app.from).not.toHaveBeenCalled();
  });

  test('keeps malformed request data out of diagnostics', async () => {
    const app = setup();
    const malformed = new Request(request(payload), { body: payload.turnstile_token.trim() });
    const response = await app.handler(malformed);

    await expectResponse(response, app.log, 400, { ok: false, error: { code: 'invalid_json' } });
    expectErrorLog(app.logError, 'invalid_json', 'Invalid JSON payload');
    expect(app.createClient).not.toHaveBeenCalled();
  });

  test('keeps client initialization detail server-side', async () => {
    const app = setup();
    const message = 'fixture client unavailable';
    app.createClient.mockImplementationOnce(() => { throw new Error(message); });
    const response = await app.handler(request(payload));

    await expectResponse(response, app.log, 500, { ok: false, error: { code: 'server_misconfigured' } });
    expectErrorLog(app.logError, 'server_misconfigured', message);
    expect(app.fetch).not.toHaveBeenCalled();
    expect(app.rpc).not.toHaveBeenCalled();
  });

  test('keeps missing IP hash prerequisites server-side', async () => {
    const app = setup();
    const req = request(payload);
    req.headers.delete('cf-connecting-ip');
    req.headers.delete('x-forwarded-for');
    const response = await app.handler(req);

    await expectResponse(response, app.log, 500, { ok: false, error: { code: 'server_misconfigured' } });
    expectErrorLog(app.logError, 'server_misconfigured', 'ip_hash_prerequisites_missing');
    expect(app.fetch).not.toHaveBeenCalled();
    expect(app.rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['lookup', 'public_tracking_lookup_v1'],
    ['verify', 'public_tracking_verify_v1'],
  ])('verifies %s before querying the configured RPC schema', async (action, rpcName) => {
    const app = setup();
    app.fetch.mockResolvedValueOnce(Response.json({ success: true, hostname: 'tracking.example.invalid' }));
    const response = await app.handler(request(payload, action));

    await expectResponse(response, app.log, 200, { ...rpcResult, turnstile_error_codes: null });
    expect(app.fetch.mock.calls).toEqual([verificationRequest]);
    expect(app.createClient.mock.calls).toEqual([[serviceUrl, serviceKey, {
      auth: { persistSession: false },
      db: { schema: 'fixture_tracking' },
      global: { headers: { apikey: serviceKey } },
    }]]);
    expect(app.rpc.mock.calls).toEqual([[rpcName, {
      p_input: {
        ...payload,
        ip_hash: createHash('sha256').update(`${salt}:${ip}`).digest('hex'),
        origin,
        turnstile_verified: true,
      },
    }]]);
    expect(app.fetch.mock.invocationCallOrder[0]).toBeLessThan(app.rpc.mock.invocationCallOrder[0]);
    expect(app.from).not.toHaveBeenCalled();
  });
});
