const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const { webcrypto } = require('crypto');

const repoRoot = path.resolve(__dirname, '../../..');
const functionsRoot = path.join(repoRoot, 'supabase/functions');
const entrypoint = path.join(functionsRoot, 'webhook-receiver/index.ts');
const REQUEST_ID = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
const INBOX_ID = '22222222-2222-4222-8222-222222222222';
const CANONICAL_ID = '33333333-3333-4333-8333-333333333333';
const BODY_ID = '44444444-4444-4444-8444-444444444444';

// Run the complete production entrypoint and its actual local shared modules.
// Only the environment, HTTP boundary and background lifetime are substituted.
function loadHandler({ result, env = {}, rpcStatus = 200, jobs = [], dispatchStatus = 200, rpcError, backgroundGate, rejectDbJwtStatus, entrypointName = 'webhook-receiver', fetchImpl } = {}) {
  const environment = {
    EDGE_SUPABASE_URL: 'http://127.0.0.1:54321',
    WEBHOOK_DB_JWT: 'fixture.db.jwt',
    PUBLIC_INGRESS_LOCAL_CORS_ALLOW_ORIGINS: 'http://127.0.0.1:3333',
    ...env,
  };
  const logs = [];
  const background = [];
  const calls = [];
  let handler;
  const sandbox = vm.createContext({
    Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    performance, crypto: webcrypto, setTimeout, clearTimeout, btoa, atob,
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [
      level, line => logs.push(JSON.parse(line)),
    ])),
    Deno: { env: { get: name => environment[name] }, serve: fn => { handler = fn; } },
    // EdgeRuntime is process-owned runtime state; request headers cannot alter it.
    EdgeRuntime: { waitUntil: promise => background.push(promise) },
    fetch: async (url, options) => {
      const target = new URL(url);
      const call = { url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body) };
      calls.push(call);
      const expectedOrigin = new URL(environment.EDGE_SUPABASE_URL).origin;
      if (target.origin !== expectedOrigin) throw new Error('Unexpected network origin');
      if (fetchImpl) return fetchImpl(target, call, options);
      if (rejectDbJwtStatus &&
          ['/rest/v1/rpc/workflow_intake_webhook', '/rest/v1/rpc/get_webhook_edge_dispatch_jobs'].includes(target.pathname) &&
          call.headers.get('apikey') === environment.WEBHOOK_DB_JWT) {
        return new Response(JSON.stringify({
          code: 'PGRST301', message: 'Invalid JWT',
        }), { status: rejectDbJwtStatus });
      }

      if (target.pathname === '/rest/v1/rpc/workflow_intake_webhook') {
        if (rpcError) throw rpcError;
        return new Response(JSON.stringify(result ?? {}), { status: rpcStatus });
      }
      if (target.pathname === '/rest/v1/rpc/get_webhook_edge_dispatch_jobs') {
        if (backgroundGate) await backgroundGate;
        return new Response(JSON.stringify(jobs), { status: 200 });
      }
      if (target.pathname === '/functions/v1/api-caller') {
        return new Response(JSON.stringify({ success: dispatchStatus < 400 }), { status: dispatchStatus });
      }
      throw new Error('Unexpected request: ' + target.pathname);
    },
  });
  const cache = new Map();
  function load(filename) {
    const resolved = path.resolve(filename);
    if (!resolved.startsWith(functionsRoot + path.sep)) throw new Error('Unexpected module path');
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const compiled = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      fileName: resolved.replace(/\.mjs$/, '.ts'),
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const execute = vm.runInContext('(function(require,module,exports){\n' + compiled + '\n})', sandbox, {
      filename: resolved, timeout: 1000,
    });
    execute(specifier => {
      if (!specifier.startsWith('.')) throw new Error('Unexpected external module');
      return load(path.resolve(path.dirname(resolved), specifier));
    }, module, module.exports);
    return module.exports;
  }
  load(entrypointName === 'webhook-receiver' ? entrypoint : path.join(functionsRoot, entrypointName, 'index.ts'));
  if (typeof handler !== 'function') throw new Error('Production Deno.serve was not registered');
  return { handler, calls, logs, drain: () => Promise.all(background) };
}

function request({ method = 'POST', headers = {}, body = '{"event":{"id":"evt-identity","type":"shipment.created"}}' } = {}) {
  return new Request('http://127.0.0.1:54321/functions/v1/webhook-receiver', {
    method,
    headers: {
      authorization: 'Bearer fixture-source-token',
      'content-type': 'application/json',
      'x-correlation-id': REQUEST_ID,
      origin: 'http://127.0.0.1:3333',
      ...headers,
    },
    ...(method === 'POST' ? { body } : {}),
  });
}

describe('gateway full entrypoint auth composition', () => {
  const intake = '/rest/v1/rpc/workflow_intake_api_gateway_v1';
  const progress = '/rest/v1/rpc/progress_api_gateway_request_workflow_v1';
  const lookup = '/rest/v1/rpc/get_api_gateway_edge_dispatch_jobs_v1';
  const dispatch = '/functions/v1/api-caller';
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const gatewayRequest = () => new Request('http://127.0.0.1:54321/functions/v1/api-gateway/shipments', {
    method: 'POST', headers: { authorization: 'Bearer fixture-client-token', 'content-type': 'application/json' },
    body: '{"reference":"fixture-reference"}',
  });
  const gateway = (fetchImpl, env = {}) => loadHandler({
    entrypointName: 'api-gateway', fetchImpl,
    env: { API_GATEWAY_DB_JWT: 'fixture.db.jwt', EDGE_SUPABASE_SECRET_KEY: 'sb_secret_fixture', ...env },
  });

  test.each([401, 403])('gateway retries allowed secret after JWT %s', async status => {
    const app = gateway((target, call) => {
      if (target.pathname === dispatch) return json({ success: true, result: { status: 200, body: {} } });
      if (![intake, progress, lookup].includes(target.pathname)) throw new Error('Unexpected RPC');
      if (call.headers.get('apikey') === 'fixture.db.jwt') return json({ code: 'PGRST301', message: 'Invalid JWT' }, status);
      if (target.pathname === intake) return json({
        action: 'accepted_async', status: 202, body: {},
        workflow_run_id: INBOX_ID, api_gateway_request_id: CANONICAL_ID,
      });
      return json(target.pathname === lookup ? [{ job_id: BODY_ID }] : {});
    }, { API_GATEWAY_REQUIRE_DB_JWT: 'false' });
    const response = await app.handler(gatewayRequest());
    await app.drain();
    expect(response.status).toBe(202);
    expect(app.calls.map(call => new URL(call.url).pathname)).toEqual([
      intake, intake, progress, progress, lookup, lookup, dispatch, progress, progress,
    ]);
    for (const index of [0, 2, 4, 7]) {
      const [jwt, secret] = app.calls.slice(index, index + 2);
      expect(jwt.headers.get('apikey')).toBe('fixture.db.jwt');
      expect(jwt.headers.get('authorization')).toBe('Bearer fixture.db.jwt');
      expect(secret.headers.get('apikey')).toBe('sb_secret_fixture');
      expect(secret.headers.get('authorization')).toBeNull();
      expect(secret.body).toEqual(jwt.body);
      for (const call of [jwt, secret]) {
        expect(call.headers.get('content-profile')).toBe('api');
        expect(call.headers.get('accept-profile')).toBe('api');
      }
    }
    expect(app.calls[6].headers.get('authorization')).toBe('Bearer fixture.db.jwt');
    const exposed = JSON.stringify(app.logs) + await response.text();
    for (const credential of ['fixture.db.jwt', 'sb_secret_fixture', 'fixture-client-token']) expect(exposed).not.toContain(credential);
    expect(app.logs.some(log => log.event === 'edge.accepted_async.background_failed')).toBe(false);
  });

  test('gateway strict default never retries configured secret', async () => {
    const app = gateway(() => json({ code: 'PGRST301', message: 'Invalid JWT' }, 401));
    const response = await app.handler(gatewayRequest());
    await app.drain();
    expect(response.status).toBe(500);
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0].headers.get('apikey')).toBe('fixture.db.jwt');
    expect(await response.text()).toContain('Failed to process API gateway intake');
  });

  test.each(['transport-error', 'null-body', 'failed-response'])('gateway safely handles %s intake', async mode => {
    const app = gateway(() => {
      if (mode === 'transport-error') throw new Error('fixture transport unavailable');
      return json(mode === 'null-body' ? null : { message: 'fixture upstream failure' }, mode === 'failed-response' ? 500 : 200);
    });
    const response = await app.handler(gatewayRequest());
    await app.drain();
    expect(response.status).toBe(500);
    expect(app.calls).toHaveLength(1);
    expect(new URL(app.calls[0].url).pathname).toBe(intake);
    const exposed = await response.text();
    expect(exposed).toContain('Failed to process API gateway intake');
    for (const text of ['fixture upstream failure', 'fixture transport unavailable', 'fixture.db.jwt', 'sb_secret_fixture']) expect(exposed).not.toContain(text);
  });

  test.each([
    ['governed local', {
      EDGE_SUPABASE_URL: 'http://xqpjiyiztkhwlxxwurxilvmo.example.invalid:8000',
      PUBLIC_EDGE_LOCAL_QA_ENABLED: '1',
    }, false],
    ['hosted', {
      EDGE_SUPABASE_URL: 'https://project.supabase.co',
    }, true],
  ])('%s runtime uses the admitted accepted-async lifetime', async (_label, env, responseBeforeRelease) => {
    let releaseLookup;
    const lookupGate = new Promise(resolve => { releaseLookup = resolve; });
    let markLookupStarted;
    const lookupStarted = new Promise(resolve => { markLookupStarted = resolve; });
    const app = gateway(async target => {
      if (target.pathname === intake) {
        return json({
          action: 'accepted_async', status: 202, body: {},
          workflow_run_id: INBOX_ID, api_gateway_request_id: CANONICAL_ID,
        });
      }
      if (target.pathname === progress) return json({ status: 'completed' });
      if (target.pathname === lookup) {
        markLookupStarted();
        await lookupGate;
        return json([]);
      }
      throw new Error('Unexpected RPC');
    }, env);

    let responseSettled = false;
    const responsePromise = app.handler(gatewayRequest()).then(response => {
      responseSettled = true;
      return response;
    });
    await lookupStarted;
    await new Promise(resolve => setImmediate(resolve));
    expect(responseSettled).toBe(responseBeforeRelease);

    releaseLookup();
    const response = await responsePromise;
    await app.drain();
    expect(response.status).toBe(202);
    expect(app.logs.some(log => log.event === 'edge.accepted_async.background_failed')).toBe(false);
  });

  test('gateway local lifetime admission is sourced from process configuration', () => {
    const source = fs.readFileSync(path.join(functionsRoot, 'api-gateway/index.ts'), 'utf8');
    expect(source).toContain('readEnv("PUBLIC_EDGE_LOCAL_QA_ENABLED") === "1"');
    expect(source).not.toMatch(/headers\.get\([^)]*PUBLIC_EDGE_LOCAL_QA_ENABLED/);
  });
});


describe('webhook full entrypoint intake timeout', () => {
  test('configured timeout aborts intake without dispatch or credential disclosure', async () => {
    let signal;
    let guard;
    const app = loadHandler({
      env: { WEBHOOK_RPC_TIMEOUT_MS: '10' },
      fetchImpl: (target, _call, options) => {
        expect(target.pathname).toBe('/rest/v1/rpc/workflow_intake_webhook');
        signal = options.signal;
        return new Promise((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error('Intake timeout was not applied')), 1000);
          const abort = () => reject(Object.assign(new Error('fixture.db.jwt timeout'), { name: 'AbortError' }));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      },
    });
    try {
      const response = await app.handler(request());
      await app.drain();
      expect(signal.aborted).toBe(true);
      expect(app.calls).toHaveLength(1);
      expect(response.status).toBe(500);
      const exposed = await response.text() + JSON.stringify(app.logs);
      expect(exposed).toContain('Failed to process webhook intake');
      expect(exposed).not.toContain('fixture.db.jwt');
      expect(exposed).not.toContain('fixture-source-token');
    } finally { clearTimeout(guard); }
  });
});
describe('webhook full entrypoint canonical identity', () => {
  test.each([
    ['async default', 202, { status: 'accepted_async', correlation_id: BODY_ID }, 'ack_sent'],
    ['sync default', 200, { status: 'accepted' }, 'ack_sent'],
    ['custom ACK', 201, { provider_receipt: 'custom-value' }, 'ack_sent'],
    ['HMAC error', 400, { error: 'HMAC signature mismatch' }, 'ack_failed'],
    ['source denial', 401, { error: 'Unauthorized webhook source' }, 'ack_failed'],
    ['intent denial', 400, { error: 'shipment_update_payload_ambiguous' }, 'ack_failed'],
    ['idempotency denial', 400, { error: 'Missing required idempotency key' }, 'ack_failed'],
    ['policy failure', 500, { error: 'Webhook ingest policy not configured' }, 'ack_failed'],
    ['replayed success', 202, { status: 'accepted_async', correlation_id: BODY_ID }, 'ack_replayed'],
    ['replayed HMAC error', 400, { error: 'HMAC signature mismatch' }, 'ack_replayed'],
  ])('%s uses DB correlation in response and observability', async (_label, status, body, ackOutcome) => {
    const app = loadHandler({ result: {
      correlation_id: CANONICAL_ID, status, body, ack_outcome: ackOutcome,
      headers: { 'x-provider-receipt': 'retained', 'x-correlation-id': BODY_ID },
      response_outcome: status >= 400 ? 'response_failed' : 'response_sent',
    } });
    const response = await app.handler(request());
    await app.drain();
    const value = await response.json();
    expect(response.status).toBe(status);
    expect(response.headers.get('x-correlation-id')).toBe(CANONICAL_ID);
    expect(value.correlation_id).toBe(CANONICAL_ID);
    expect(response.headers.get('x-provider-receipt')).toBe('retained');
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3333');
    if (body.provider_receipt) expect(value.provider_receipt).toBe(body.provider_receipt);
    expect(app.logs.find(record => record.event === 'webhook_http_response')).toMatchObject({
      correlation_id: CANONICAL_ID, response_status: status,
    });
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0].headers.get('content-profile')).toBe('api');
    expect(app.calls[0].headers.get('accept-profile')).toBe('api');
    expect(app.calls[0].body.p_headers['x-correlation-id']).toBe(REQUEST_ID);
    expect(JSON.stringify(app.logs)).not.toContain('fixture-source-token');
  });

  test.each([
    [{ correlation_id: BODY_ID }, BODY_ID],
    [{ webhook: { correlation_id: BODY_ID } }, BODY_ID],
    [{ status: 'accepted' }, REQUEST_ID],
  ])('retains older-response fallback without querying tables (case %#)', async (body, expected) => {
    const app = loadHandler({ result: { status: 202, body } });
    const response = await app.handler(request());
    await app.drain();
    expect(response.headers.get('x-correlation-id')).toBe(expected);
    expect(app.calls).toHaveLength(1);
  });

  test('preserves custom scalar ACK while putting canonical identity in headers', async () => {
    const app = loadHandler({ result: { status: 200, body: 'provider-ok', correlation_id: CANONICAL_ID } });
    const response = await app.handler(request());
    await app.drain();
    expect(await response.text()).toBe('provider-ok');
    expect(response.headers.get('x-correlation-id')).toBe(CANONICAL_ID);
  });

  test('dispatch consumes inbox identity and canonical correlation without delaying ACK', async () => {
    let release;
    const backgroundGate = new Promise(resolve => { release = resolve; });
    let deadline;
    const app = loadHandler({
      result: { status: 202, body: {}, correlation_id: CANONICAL_ID, webhook_id: INBOX_ID },
      jobs: [{ job_id: 'job-identity', timeout_seconds: 3 }],
      dispatchStatus: 503, backgroundGate,
    });
    try {
      const response = await Promise.race([
        app.handler(request()),
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('ACK waited for background dispatch')), 1000);
        }),
      ]);
      expect(response.status).toBe(202);
      expect(app.calls.some(call => call.url.endsWith('/functions/v1/api-caller'))).toBe(false);
    } finally {
      clearTimeout(deadline);
      release();
      await app.drain();
    }
    expect(app.calls[1].body).toEqual({ p_webhook_id: INBOX_ID });
    expect(app.calls[2].headers.get('x-correlation-id')).toBe(CANONICAL_ID);
    expect(app.calls[2].body).toEqual({ job_id: 'job-identity', timeout_seconds: 3 });
    expect(app.logs.find(record => record.event === 'edge.dispatch.invoke_failed')).toMatchObject({
      correlation_id: CANONICAL_ID,
    });
  });

  test.each([
    ['missing token', { headers: { authorization: '' } }, 401],
    ['invalid JSON', { body: '{' }, 400],
    ['method', { method: 'GET', headers: { origin: '' } }, 405],
    ['CORS method', { method: 'GET' }, 403],
    ['denied origin', { headers: { origin: 'https://untrusted.invalid' } }, 403],
  ])('%s remains a pre-DB rejection with request identity', async (_label, options, status) => {
    const app = loadHandler();
    const response = await app.handler(request(options));
    await app.drain();
    expect(response.status).toBe(status);
    expect(response.headers.get('x-correlation-id')).toBe(REQUEST_ID);
    expect((await response.json()).correlation_id).toBe(REQUEST_ID);
    expect(app.calls).toEqual([]);
  });

  test.each([
    ['recorded', undefined],
    ['suppressed', 'budget_exhausted'],
    ['suppressed', 'budget_busy'],
    ['suppressed', 'recorder_unavailable'],
    ['suppressed', 'policy_disabled'],
  ])('source rejection exposes only safe logging outcome %s/%s without another RPC', async (status, reason) => {
    const app = loadHandler({ result: {
      status: 401, correlation_id: CANONICAL_ID,
      ack_outcome: 'ack_failed', response_outcome: 'response_failed', response_mode: 'accepted_async',
      body: { error: 'Unauthorized webhook source' },
      auth_rejection_logging: { status, reason, source_id: 'private-source', organization_id: 'private-org', id: 'private-record' },
    } });
    const response = await app.handler(request());
    await app.drain();
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({
      code: 'edge.response.error', error: 'Unauthorized webhook source', message: 'Unauthorized webhook source',
      status: 401, correlation_id: CANONICAL_ID, request_id: null, trace_id: REQUEST_ID.replace(/-/g, ''),
    });
    expect(body).not.toHaveProperty('auth_rejection_logging');
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0].url).toMatch(/\/rpc\/workflow_intake_webhook$/);
    expect(app.logs.find(record => record.event === 'webhook_http_response')).toMatchObject({
      correlation_id: CANONICAL_ID, rejection_log_status: status, rejection_log_reason: reason ?? null,
    });
    for (const secret of ['fixture-source-token', 'private-source', 'private-org', 'private-record']) {
      expect(JSON.stringify(app.logs)).not.toContain(secret);
    }
  });

  test.each([401, 403])('reuses configured JWT then allowed secret fallback after %s auth rejection for intake and dispatch lookup', async rejectDbJwtStatus => {
    const app = loadHandler({
      env: {
        WEBHOOK_REQUIRE_DB_JWT: 'false',
        EDGE_SUPABASE_SECRET_KEY: 'sb_secret_fixture_f303',
        EDGE_SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-disallowed',
      },
      rejectDbJwtStatus,
      result: { status: 202, body: { status: 'accepted_async' }, correlation_id: CANONICAL_ID, webhook_id: INBOX_ID },
      jobs: [{ job_id: 'job-f303', timeout_seconds: 3 }],
    });
    const response = await app.handler(request());
    const body = await response.json();
    await app.drain();
    expect(response.status).toBe(202);
    expect(body).toEqual({ status: 'accepted_async', correlation_id: CANONICAL_ID });
    expect(response.headers.get('x-correlation-id')).toBe(CANONICAL_ID);
    expect(app.calls.map(call => new URL(call.url).pathname)).toEqual([
      '/rest/v1/rpc/workflow_intake_webhook', '/rest/v1/rpc/workflow_intake_webhook',
      '/rest/v1/rpc/get_webhook_edge_dispatch_jobs', '/rest/v1/rpc/get_webhook_edge_dispatch_jobs',
      '/functions/v1/api-caller',
    ]);
    for (const start of [0, 2]) {
      const [jwt, secret] = app.calls.slice(start, start + 2);
      expect(jwt.headers.get('apikey')).toBe('fixture.db.jwt');
      expect(jwt.headers.get('authorization')).toBe('Bearer fixture.db.jwt');
      expect(secret.headers.get('apikey')).toBe('sb_secret_fixture_f303');
      expect(secret.headers.get('authorization')).toBeNull();
      expect(secret.body).toEqual(jwt.body);
      for (const call of [jwt, secret]) {
        expect(call.headers.get('content-profile')).toBe('api');
        expect(call.headers.get('accept-profile')).toBe('api');
      }
    }
    expect(app.calls[0].body.p_token).toBe('fixture-source-token');
    expect(app.calls[0].body.p_headers['x-correlation-id']).toBe(REQUEST_ID);
    expect(app.calls[2].body).toEqual({ p_webhook_id: INBOX_ID });
    expect(app.calls[4].headers.get('authorization')).toBe('Bearer fixture.db.jwt');
    expect(app.calls[4].headers.get('x-correlation-id')).toBe(CANONICAL_ID);
    expect(app.calls[4].body).toEqual({ job_id: 'job-f303', timeout_seconds: 3 });
    for (const secret of ['fixture.db.jwt', 'sb_secret_fixture_f303', 'fixture-service-disallowed', 'fixture-source-token']) {
      expect(JSON.stringify(app.logs)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain(secret);
    }
  });

  test('strict default does not use a configured secret after DB JWT rejection', async () => {
    const app = loadHandler({ env: { EDGE_SUPABASE_SECRET_KEY: 'sb_secret_fixture_f303' }, rejectDbJwtStatus: 401 });
    const response = await app.handler(request());
    await app.drain();
    expect(response.status).toBe(500);
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0].headers.get('apikey')).toBe('fixture.db.jwt');
    expect(JSON.stringify(await response.json())).not.toContain('Invalid JWT');
    expect(JSON.stringify(app.logs)).not.toContain('sb_secret_fixture_f303');
  });

  test.each(['', 'fixture-service-not-authorized'])('secret-only intake without permitted internal JWT skips dispatch (%s)', async serviceKey => {
    const app = loadHandler({
      env: { WEBHOOK_DB_JWT: '', WEBHOOK_REQUIRE_DB_JWT: 'false', EDGE_SUPABASE_SECRET_KEY: 'sb_secret_fixture_f303', EDGE_SUPABASE_SERVICE_ROLE_KEY: serviceKey },
      result: { status: 202, body: {}, correlation_id: CANONICAL_ID, webhook_id: INBOX_ID },
      jobs: [{ job_id: 'must-not-dispatch' }],
    });
    const response = await app.handler(request());
    await app.drain();
    expect(response.status).toBe(202);
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0].url).toMatch(/\/rpc\/workflow_intake_webhook$/);
    expect(app.calls[0].headers.get('apikey')).toBe('sb_secret_fixture_f303');
    expect(app.calls[0].headers.get('authorization')).toBeNull();
  });

  test('OPTIONS remains pre-DB and preserves CORS identity', async () => {
    const app = loadHandler();
    const response = await app.handler(request({ method: 'OPTIONS', headers: {
      'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type',
    } }));
    await app.drain();
    expect(response.status).toBe(204);
    expect(response.headers.get('x-correlation-id')).toBe(REQUEST_ID);
    expect(app.calls).toEqual([]);
  });

  test('missing DB credentials remains fail-closed without a service-role fallback', async () => {
    const app = loadHandler({ env: { WEBHOOK_DB_JWT: '', EDGE_SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key' } });
    const response = await app.handler(request());
    await app.drain();
    expect(response.status).toBe(500);
    expect(app.calls).toEqual([]);
    expect(JSON.stringify(app.logs)).not.toContain('fixture-service-key');
  });

  test.each([
    [{ rpcStatus: 503, result: { message: 'unavailable' } }],
    [{ rpcError: new Error('offline') }],
  ])('RPC transport failure retains request identity and does not dispatch (case %#)', async options => {
    const app = loadHandler(options);
    const response = await app.handler(request());
    await app.drain();
    expect(response.status).toBe(500);
    expect(response.headers.get('x-correlation-id')).toBe(REQUEST_ID);
    expect(app.calls).toHaveLength(1);
  });
});
