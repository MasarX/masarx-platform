const { createHmac, randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { createEdgeDbJwt, buildSupabaseApiKeys } = require('../../../scripts/ops/workspace/edge-db-jwt');

const endpoint = ['https://renderer', 'example', 'test'].join('.') + '/functions/v1/label-renderer';
const projectSecret = randomBytes(32);
const publicKeys = buildSupabaseApiKeys({ secret: projectSecret });
const apiCallerJwt = createEdgeDbJwt({ secret: projectSecret, role: 'edge_api_caller_role' });
const gatewayJwt = createEdgeDbJwt({ secret: projectSecret, role: 'edge_renderer_gateway_role' });
const tokenFrom = (dispatch) => dispatch.headers['x-masarx-renderer-token'];
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
let authorizeRendererSend;
let invocation;

beforeAll(async () => {
  ({ authorizeRendererSend } = await import('../../../supabase/functions/api-caller/renderer-auth.mjs'));
  invocation = await import('../../../supabase/functions/api-caller/invocation.mjs');
});

test('signs a distinct renderer JWT for each send with a 60-second lifetime', async () => {
  const secret = randomBytes(32).toString('hex');
  const spec = { url: endpoint, method: 'POST', headers: {} };
  const first = await authorizeRendererSend(spec, endpoint, secret, gatewayJwt);
  const second = await authorizeRendererSend(spec, endpoint, secret, gatewayJwt);
  expect(tokenFrom(second)).not.toBe(tokenFrom(first));
  expect(spec.headers).toEqual({});

  for (const dispatch of [first, second]) {
    expect(dispatch.headers.authorization).toBe(`Bearer ${gatewayJwt}`);
    const [header, payload, signature] = tokenFrom(dispatch).split('.');
    expect(decode(header)).toEqual({ alg: 'HS256', typ: 'JWT' });
    const claims = decode(payload);
    expect(claims).toMatchObject({ role: 'edge_label_renderer_role', aud: 'authenticated', sub: 'edge-function' });
    expect(claims.exp - claims.iat).toBe(60);
    expect(signature).toBe(createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'));
  }
});

test('refuses any different endpoint and fails closed without the server signing secret', async () => {
  const secret = randomBytes(32).toString('hex');
  const differentOrigin = endpoint.replace('renderer', 'second');
  await expect(authorizeRendererSend({ url: differentOrigin }, endpoint, secret, gatewayJwt)).rejects.toThrow('renderer_endpoint_not_authorized');
  await expect(authorizeRendererSend({ url: `${endpoint}?other=1` }, endpoint, secret, gatewayJwt)).rejects.toThrow('renderer_endpoint_not_authorized');
  await expect(authorizeRendererSend({ url: endpoint }, endpoint, '', gatewayJwt)).rejects.toThrow('renderer_signer_unavailable');
});

test.each(['', publicKeys.anon, publicKeys.service, apiCallerJwt])(
  'requires the gateway-only JWT', async (gatewayKey) => {
    await expect(authorizeRendererSend({ url: endpoint }, endpoint, randomBytes(32).toString('hex'), gatewayKey))
      .rejects.toThrow('renderer_gateway_jwt_required');
  },
);

const source = readFileSync(resolve(__dirname, '../../../supabase/functions/api-caller/index.ts'), 'utf8');
const { outputText } = ts.transpileModule(`${source}\nmodule.exports = { executeClaimedJobById };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function loadWorker({ stale = false, responseStatus = 200 } = {}) {
  const calls = [];
  const logError = jest.fn();
  const spec = { url: endpoint, method: 'POST', body: {}, headers: {}, renderer_credential_ref: crypto.randomUUID() };
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_claimed_edge_job_call_spec_v1') {
      return stale ? { error: { message: 'active lease not found' } } : { data: spec };
    }
    return {};
  };
  const edgeModule = { exports: {} };
  const deps = {
    'npm:@supabase/supabase-js@2.111.0': { createClient: () => ({ rpc }) },
    './auth.mjs': {},
    './invocation.mjs': invocation,
    './proxy.mjs': { createGuardedProxyFetch: () => undefined },
    './renderer-auth.mjs': {
      RENDERER_TOKEN_HEADER: 'x-masarx-renderer-token',
      authorizeRendererSend: async (...args) => {
        calls.push({ name: 'mint' });
        return authorizeRendererSend(...args);
      },
    },
    './egress.mjs': { executeBoundedEgress: async (args) => {
      calls.push({ name: 'send', args });
      return { status: responseStatus, completed: true, headers: {}, body: {}, latency_ms: 1 };
    } },
    './_shared/mod.mjs': { readEnv: (key) => ({
      EDGE_SUPABASE_URL: new URL(endpoint).origin,
      EDGE_SUPABASE_ANON_KEY: publicKeys.anon,
      API_CALLER_DB_JWT: apiCallerJwt,
      LABEL_RENDERER_GATEWAY_JWT: gatewayJwt,
      LABEL_RENDERER_SIGNING_KEY: randomBytes(32).toString('hex'),
    })[key] ?? '' },
  };
  runInNewContext(outputText, {
    module: edgeModule, exports: edgeModule.exports, Error, URL, Headers, TextEncoder, fetch,
    console: { ...console, error: logError },
    require: (name) => deps[name], Deno: { serve: () => {} },
  });
  return { calls, execute: edgeModule.exports.executeClaimedJobById, spec, logError };
}

test('resolves under the lease, renews ownership, and uses the token only for transport', async () => {
  const { calls, execute, spec } = loadWorker();
  const jobId = crypto.randomUUID();
  const lease = crypto.randomUUID();
  const result = await execute(jobId, lease);
  expect(calls.map(({ name }) => name)).toEqual([
    'get_claimed_edge_job_call_spec_v1', 'renew_claimed_edge_job_lease_v1', 'mint', 'send',
    'renew_claimed_edge_job_lease_v1', 'mark_claimed_edge_job_success_v1',
  ]);
  expect(calls[0].args).toEqual({ p_job_id: jobId, p_lease_token: lease });
  expect(calls[3].args.policy.followRedirects).toBe(false);
  expect(calls[3].args.policy.headerAllowlist).toContain('x-masarx-renderer-token');
  expect(calls[3].args.headers.authorization).toBe(`Bearer ${gatewayJwt}`);
  expect(spec.headers).toEqual({});
  expect(JSON.stringify(result)).not.toContain(tokenFrom(calls[3].args));
});

test('stale spec lease stops before token minting, fetch, or finalization', async () => {
  const { calls, execute } = loadWorker({ stale: true });
  await expect(execute(crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow('active lease not found');
  expect(calls.map(({ name }) => name)).toEqual(['get_claimed_edge_job_call_spec_v1']);
});

test.each([401, 403])('settles renderer gateway %d as a single terminal failure', async (responseStatus) => {
  const { calls, execute, logError } = loadWorker({ responseStatus });
  const jobId = crypto.randomUUID();
  const lease = crypto.randomUUID();
  await expect(execute(jobId, lease)).resolves.toMatchObject({
    success: false, result: { status: responseStatus, error: 'renderer_gateway_rejected' },
  });
  expect(calls.map(({ name }) => name)).toEqual([
    'get_claimed_edge_job_call_spec_v1', 'renew_claimed_edge_job_lease_v1', 'mint', 'send',
    'renew_claimed_edge_job_lease_v1', 'mark_claimed_edge_job_failure_v1',
  ]);
  expect(calls.at(-1).args).toMatchObject({
    p_job_id: jobId, p_lease_token: lease, p_status_code: responseStatus, p_error: 'renderer_gateway_rejected',
  });
  expect(logError.mock.calls).toEqual([['[api-caller] renderer_gateway_rejected']]);
});
