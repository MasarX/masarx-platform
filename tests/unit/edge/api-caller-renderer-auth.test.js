const { createHmac, randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

const endpoint = ['https://renderer', 'example', 'test'].join('.') + '/functions/v1/label-renderer';
const tokenFrom = (dispatch) => dispatch.headers.authorization.split(' ')[1];
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
  const first = tokenFrom(await authorizeRendererSend(spec, endpoint, secret));
  const second = tokenFrom(await authorizeRendererSend(spec, endpoint, secret));
  expect(second).not.toBe(first);
  expect(spec.headers).toEqual({});

  for (const jwt of [first, second]) {
    const [header, payload, signature] = jwt.split('.');
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
  await expect(authorizeRendererSend({ url: differentOrigin }, endpoint, secret)).rejects.toThrow('renderer_endpoint_not_authorized');
  await expect(authorizeRendererSend({ url: `${endpoint}?other=1` }, endpoint, secret)).rejects.toThrow('renderer_endpoint_not_authorized');
  await expect(authorizeRendererSend({ url: endpoint }, endpoint, '')).rejects.toThrow('renderer_signer_unavailable');
});

const source = readFileSync(resolve(__dirname, '../../../supabase/functions/api-caller/index.ts'), 'utf8');
const { outputText } = ts.transpileModule(`${source}\nmodule.exports = { executeClaimedJobById };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function loadWorker({ stale = false } = {}) {
  const calls = [];
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
    './renderer-auth.mjs': { authorizeRendererSend: async (...args) => {
      calls.push({ name: 'mint' });
      return authorizeRendererSend(...args);
    } },
    './egress.mjs': { executeBoundedEgress: async (args) => {
      calls.push({ name: 'send', args });
      return { status: 200, completed: true, headers: {}, body: { ok: true }, latency_ms: 1 };
    } },
    './_shared/mod.mjs': { readEnv: (key) => ({
      EDGE_SUPABASE_URL: new URL(endpoint).origin,
      EDGE_SUPABASE_ANON_KEY: 'fixture',
      API_CALLER_DB_JWT: ['header', 'payload', 'signature'].join('.'),
      LABEL_RENDERER_SIGNING_KEY: randomBytes(32).toString('hex'),
    })[key] ?? '' },
  };
  runInNewContext(outputText, {
    module: edgeModule, exports: edgeModule.exports, Error, URL, Headers, TextEncoder, fetch, console,
    require: (name) => deps[name], Deno: { serve: () => {} },
  });
  return { calls, execute: edgeModule.exports.executeClaimedJobById, spec };
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
  expect(spec.headers).toEqual({});
  expect(JSON.stringify(result)).not.toContain(tokenFrom(calls[3].args));
});

test('stale spec lease stops before token minting, fetch, or finalization', async () => {
  const { calls, execute } = loadWorker({ stale: true });
  await expect(execute(crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow('active lease not found');
  expect(calls.map(({ name }) => name)).toEqual(['get_claimed_edge_job_call_spec_v1']);
});
