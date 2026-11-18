const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const ids = {
  stop: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
  target: '22222222-2222-4222-8222-222222222222',
  actor: '33333333-3333-4333-8333-333333333333',
  request: '44444444-4444-4444-8444-444444444444',
  task: '55555555-5555-4555-8555-555555555555',
  run: '66666666-6666-4666-8666-666666666666',
  dispatch: '77777777-7777-4777-8777-777777777777',
  decision: '88888888-8888-4888-8888-888888888888',
};
function payload() {
  return { p_action_key: 'route_stops.request_reassignment', p_resource_key: 'route_stops',
    p_selection_id: ids.stop, p_selection_ids: [ids.stop], p_selection_count: 1,
    p_idempotency_key: 'outbox_durable_key', p_expected_actor_user_id: ids.actor,
    p_params: { payload: { target_driver_id: ids.target, reason: 'Capacity request' } } };
}
function handler(options = {}) {
  let serve;
  const userRpc = jest.fn().mockResolvedValue(options.prepared || { data: { request_id: ids.request }, error: null });
  const success = { ok: true, request_id: ids.request, dispatch_task_id: ids.task,
    workflow_run_id: ids.run, dispatch_id: ids.dispatch, decision_log_id: ids.decision };
  const serviceRpc = jest.fn().mockResolvedValue(options.submitted || { data: success, error: null });
  const createClient = jest.fn((_url, key) => ({ rpc: key === 'anon' ? userRpc : serviceRpc }));
  const env = { EDGE_SUPABASE_URL: 'https://project.invalid', EDGE_SUPABASE_ANON_KEY: 'anon',
    EDGE_SUPABASE_SECRET_KEY: options.secret === false ? '' : 'sb_secret_fixture',
    EDGE_SUPABASE_SERVICE_ROLE_KEY: 'service-jwt-fixture', ...options.env };
  const source = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/fieldops-reassignment-request/index.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, {
    exports: {}, Response, Request, Headers, console,
    Deno: { serve: (fn) => { serve = fn; } },
    require: (name) => {
      if (name === 'npm:@supabase/supabase-js@2.111.0') return { createClient };
      if (name === './_shared/mod.mjs') return {
        readEnv: (primary, fallbacks = []) => [primary, ...fallbacks].map((k) => env[k]).find(Boolean) || '',
        extractToken: (req) => req.headers.get('authorization')?.replace(/^Bearer /, '') || '',
        parseRequestBody: async (req) => ({ json: await req.json() }),
      };
      throw new Error('Unexpected module: ' + name);
    },
  });
  const send = (body = payload(), method = 'POST', token = 'actor-token') => serve(new Request('https://project.invalid/functions/v1/fieldops-reassignment-request', {
    method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), origin: 'https://console.example' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }));
  return { send, serve, userRpc, serviceRpc, createClient };
}

test('real handler performs user preparation then service-only ID submission and returns exact identities', async () => {
  const h = handler();
  const body = payload();
  body.organization_id = 'spoofed';
  body.p_params.payload.task_type_key = 'spoofed';
  const response = await h.send(body);
  expect(response.status).toBe(200);
  expect((await response.json()).dispatch_task_id).toBe(ids.task);
  expect(h.userRpc).toHaveBeenCalledWith('prepare_fieldops_reassignment_v1', {
    p_stop_id: ids.stop, p_target_driver_id: ids.target, p_reason: 'Capacity request',
    p_idempotency_key: 'outbox_durable_key', p_expected_actor_user_id: ids.actor,
  });
  expect(h.serviceRpc).toHaveBeenCalledWith('submit_fieldops_reassignment_v1', { p_request_id: ids.request });
  expect(h.userRpc.mock.invocationCallOrder[0]).toBeLessThan(h.serviceRpc.mock.invocationCallOrder[0]);
  expect(h.createClient.mock.calls[0][2]).toMatchObject({ db: { schema: 'api' }, global: { headers: { Authorization: 'Bearer actor-token' } } });
  expect(h.createClient.mock.calls[1][1]).toBe('sb_secret_fixture');
  expect(h.createClient.mock.calls[1][2]).toMatchObject({ db: { schema: 'api' } });
  expect(response.headers.get('access-control-allow-origin')).toBe('https://console.example');
});

test.each([['OPTIONS', 204], ['GET', 405]])('method %s is handled without auth or DB calls', async (method, status) => {
  const h = handler();
  expect((await h.send(null, method, '')).status).toBe(status);
  expect(h.createClient).not.toHaveBeenCalled();
});
test('missing bearer and malformed request never enter service context', async () => {
  const h = handler();
  expect((await h.send(payload(), 'POST', '')).status).toBe(401);
  const body = payload(); body.p_selection_ids = [ids.target];
  expect((await h.send(body)).status).toBe(400);
  expect(h.createClient).not.toHaveBeenCalled();
});
test.each([
  ['42501', 403], ['23505', 409], ['22023', 400], ['55000', 503],
])('preparation %s is a non-success response before service dispatch', async (code, status) => {
  const h = handler({ prepared: { data: null, error: { code, message: 'private-diagnostic' } } });
  const response = await h.send();
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain('private-diagnostic');
  expect(h.serviceRpc).not.toHaveBeenCalled();
});
test.each(['request_id', 'dispatch_task_id', 'workflow_run_id', 'dispatch_id', 'decision_log_id'])('missing %s cannot become queue success', async (field) => {
  const data = { ok: true, request_id: ids.request, dispatch_task_id: ids.task,
    workflow_run_id: ids.run, dispatch_id: ids.dispatch, decision_log_id: ids.decision };
  delete data[field];
  const h = handler({ submitted: { data, error: null } });
  expect((await h.send()).status).toBe(503);
});
test('service errors are non-2xx and JWT service key remains supported', async () => {
  const h = handler({ secret: false, submitted: { data: null, error: { message: 'private-sql' } } });
  const response = await h.send();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private-sql');
  expect(h.createClient.mock.calls[1][1]).toBe('service-jwt-fixture');
});
test('malformed prepared identity and thrown network errors do not fabricate success', async () => {
  const h = handler({ prepared: { data: { request_id: 'bad' }, error: null } });
  expect((await h.send()).status).toBe(503);
  expect(h.serviceRpc).not.toHaveBeenCalled();
  const network = handler();
  network.userRpc.mockRejectedValueOnce(new Error('network'));
  expect((await network.send()).status).toBe(503);
});
test('function registry keeps handler-authenticated deployment explicit', () => {
  const registry = JSON.parse(fs.readFileSync('config/edge/functions.json', 'utf8'));
  expect(registry.functions.find((f) => f.name === 'fieldops-reassignment-request')).toEqual({
    name: 'fieldops-reassignment-request', auth_mode: 'public_no_jwt', enabled: true,
  });
});

test.each([{ ok: false }, { request_id: ids.target }])('inconsistent service envelope %j cannot complete the queue', async (override) => {
  const data = { ok: true, request_id: ids.request, dispatch_task_id: ids.task,
    workflow_run_id: ids.run, dispatch_id: ids.dispatch, decision_log_id: ids.decision, ...override };
  const h = handler({ submitted: { data, error: null } });
  expect((await h.send()).status).toBe(503);
});
test('actual malformed JSON is rejected without either RPC', async () => {
  const h = handler();
  const response = await h.serve(new Request('https://project.invalid/functions/v1/fieldops-reassignment-request', {
    method: 'POST', headers: { authorization: 'Bearer actor-token' }, body: '{broken',
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ ok: false, error: { code: 'invalid_json' } });
  expect(h.userRpc).not.toHaveBeenCalled();
  expect(h.serviceRpc).not.toHaveBeenCalled();
});
