const { randomBytes, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { buildSupabaseApiKeys, createEdgeDbJwt } = require('../../../scripts/ops/workspace/edge-db-jwt');

const source = readFileSync(resolve(__dirname, '../../../supabase/functions/api-caller/index.ts'), 'utf8');
const supabaseImport = ts.preProcessFile(source, true).importedFiles
  .find(({ fileName }) => fileName.startsWith('npm:@supabase/supabase-js@'));
const { outputText } = ts.transpileModule(source + '\nmodule.exports = { executeClaimedJobById };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

const transportHeader = 'x-masarx-renderer-transport';
const rendererHeader = { 'x-masarx-edge-function': 'label-renderer' };
const legacyBody = { error: 'Unauthorized role' };
const origin = new URL('http://127.0.0.1');
const endpoint = new URL('/functions/v1/label-renderer', origin).href;
const projectSecret = randomBytes(32);
const apiCallerJwt = createEdgeDbJwt({ secret: projectSecret, role: 'edge_api_caller_role' });
const gatewayJwt = createEdgeDbJwt({ secret: projectSecret, role: 'edge_renderer_gateway_role' });
let invocation;
let rendererAuth;
let egress;

beforeAll(async () => {
  [invocation, rendererAuth, egress] = await Promise.all([
    import('../../../supabase/functions/api-caller/invocation.mjs'),
    import('../../../supabase/functions/api-caller/renderer-auth.mjs'),
    import('../../../supabase/functions/api-caller/egress.mjs'),
  ]);
});

function loadWorker({ payload, status, body, headers }) {
  const requests = [];
  const spec = {
    url: endpoint, method: 'POST', headers: {}, body: payload, renderer_credential_ref: randomUUID(),
  };
  const send = jest.fn(async () => Response.json(body, { status, headers }));
  const edgeModule = { exports: {} };
  const deps = {
    [supabaseImport.fileName]: {
      createClient: (_url, _key, options) => ({
        rpc: async (name, args) => {
          const headers = options.global.headers;
          requests.push({ name, args, headers });
          if (name === 'get_claimed_edge_job_call_spec_v1') {
            return { data: headers[transportHeader] === '1' ? spec : null };
          }
          return {};
        },
      }),
    },
    './auth.mjs': {},
    './invocation.mjs': invocation,
    './renderer-auth.mjs': rendererAuth,
    './proxy.mjs': { createGuardedProxyFetch: () => undefined },
    './egress.mjs': { executeBoundedEgress: (args) => egress.executeBoundedEgress({ ...args, directFetch: send }) },
    './_shared/mod.mjs': {
      readEnv: (key) => ({
        EDGE_SUPABASE_URL: origin.origin,
        EDGE_SUPABASE_ANON_KEY: buildSupabaseApiKeys({ secret: projectSecret }).anon,
        API_CALLER_DB_JWT: apiCallerJwt,
        EDGE_ENVIRONMENT: 'local',
        LABEL_RENDERER_GATEWAY_JWT: gatewayJwt,
        LABEL_RENDERER_SIGNING_KEY: randomBytes(32).toString('hex'),
      })[key] ?? '',
    },
  };
  runInNewContext(outputText, {
    module: edgeModule, exports: edgeModule.exports, URL, Headers, TextEncoder, fetch,
    console: { ...console, warn: jest.fn(), error: jest.fn() },
    require: (name) => deps[name], Deno: { serve: () => {} },
  });
  return { requests, send, execute: edgeModule.exports.executeClaimedJobById };
}

test.each([
  ['render', { max_jobs: 1 }],
  ['print', { mode: 'print' }],
])('defers a queued %s after the legacy renderer rejects the signed transport', async (_kind, payload) => {
  const { execute, requests, send } = loadWorker({ payload, status: 403, body: legacyBody, headers: rendererHeader });
  const job = { p_job_id: randomUUID(), p_lease_token: randomUUID() };
  await expect(execute(job.p_job_id, job.p_lease_token)).resolves.toMatchObject({
    success: false, result: { status: 503, completed: false, error: 'renderer_transport_deferred' },
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toMatchObject({
    body: JSON.stringify(payload),
    headers: { authorization: 'Bearer ' + gatewayJwt },
  });
  expect(requests.map(({ name }) => name)).toEqual([
    'get_claimed_edge_job_call_spec_v1', 'renew_claimed_edge_job_lease_v1',
    'renew_claimed_edge_job_lease_v1', 'get_claimed_edge_job_call_spec_v1',
  ]);
  expect(requests.every(({ args }) => args.p_job_id === job.p_job_id && args.p_lease_token === job.p_lease_token))
    .toBe(true);
  expect(requests[0].headers[transportHeader]).toBe('1');
  expect(requests.at(-1).headers).toEqual({ Authorization: 'Bearer ' + apiCallerJwt });
});

test.each([
  ['a gateway 403', 403, legacyBody, {}],
  ['a renderer 401', 401, legacyBody, rendererHeader],
  ['a different renderer 403', 403, { error: 'Unauthorized renderer operation' }, rendererHeader],
  ['a signed renderer role rejection', 403, legacyBody, { ...rendererHeader, [transportHeader]: '1' }],
])('settles %s as a terminal renderer failure', async (_case, status, body, headers) => {
  const { execute, requests, send } = loadWorker({ payload: {}, status, body, headers });
  await expect(execute(randomUUID(), randomUUID())).resolves.toMatchObject({
    success: false, result: { status, error: 'renderer_gateway_rejected' },
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(requests.at(-1)).toMatchObject({
    name: 'mark_claimed_edge_job_failure_v1', args: { p_status_code: status, p_error: 'renderer_gateway_rejected' },
  });
  expect(requests.every(({ headers }) => headers[transportHeader] === '1')).toBe(true);
});
