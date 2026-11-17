const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const { webcrypto } = require('crypto');
const root = path.resolve(__dirname, '../../../supabase/functions');
const compiledCache = new Map();
const ID = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
const HOSTED = 'https://landing.example.test';
const LOCAL = 'http://127.0.0.1:5199';
const facades = [
  ['marketing-lead-intake', 'MARKETING_CORS_ALLOW_ORIGINS'],
  ['public-shipment-tracking', 'PUBLIC_TRACKING_CORS_ALLOW_ORIGINS'],
  ['tenant-signup-intake', 'TENANT_SIGNUP_CORS_ALLOW_ORIGINS'],
  ['driver-signup-intake', 'DRIVER_SIGNUP_CORS_ALLOW_ORIGINS'],
  ['driver-application-status', 'DRIVER_SIGNUP_CORS_ALLOW_ORIGINS'],
];

// Execute real entrypoints and local modules; only environment, Supabase client,
// and fetch boundaries are substituted. No native JWT verification is claimed.
function loadHandler(name, { env = {}, createResult = {}, approvalResult = {}, policy = {},
  entryResult = { ok: true, organization_id: ID, organization_slug: 'owned-entry-org' } } = {}) {
  const environment = {
    EDGE_SUPABASE_URL: 'https://db.example.test',
    EDGE_SUPABASE_ANON_KEY: 'fixture.anon.jwt',
    EDGE_SUPABASE_SECRET_KEY: 'sb_secret_fixture',
    MARKETING_CORS_ALLOW_ORIGINS: HOSTED,
    MARKETING_IP_HASH_SALT: 'fixture-salt',
    ...env,
  };
  const calls = [];
  const clients = [];
  const rpc = async (name, input) => {
    calls.push({ kind: 'rpc', name, input });
    if (name === 'marketplace_public_entry_resolve_v1') return { data: entryResult, error: null };
    if (name === 'tenant_signup_policy_v1' || name === 'marketplace_compliance_policy_v1') {
      return { data: { enabled: true, turnstile: { required: false }, onboarding: { invite_redirect_to: 'https://console.example.test/invite' }, ...policy }, error: null };
    }
    if (name === 'marketplace_participant_request_get_v1') return { data: { id: ID, status: 'pending', requested_participant_type_key: 'freelancer_driver', email: 'person@example.test', full_name: 'Person', organization_name: 'Example' }, error: null };
    if (name === 'tenant_signup_request_create_v1') return { data: { ok: true, id: ID, ...createResult }, error: null };
    if (name === 'tenant_signup_review_apply_v1') return { data: { ok: true, status: 'approved', ...approvalResult }, error: null };
    if (['marketplace_participant_request_create_v1', 'marketplace_application_status_by_token_v1',
      'public_tracking_session_v1', 'public_tracking_lookup_v1'].includes(name)) {
      return { data: { ok: true, id: ID, status: 'pending' }, error: null };
    }
    throw new Error('Unexpected RPC: ' + name);
  };
  const serviceClient = {
    rpc,
    from: table => {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => {
        calls.push({ kind: 'table', table });
        return { data: { id: ID, status: 'pending', email: 'person@example.test', full_name: 'Person', organization_name: 'Example' }, error: null };
      } };
      return query;
    },
    auth: { admin: {
      inviteUserByEmail: async (email, options) => {
        calls.push({ kind: 'invite', email, options });
        return { data: { user: { id: ID } }, error: null };
      },
    } },
  };
  let handler;
  const errorLogs = [];
  const sandbox = vm.createContext({
    Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, performance, crypto: webcrypto, setTimeout, clearTimeout, btoa, atob,
    console: { log() {}, warn() {}, error(line) { errorLogs.push(line); } },
    Deno: { env: { get: key => environment[key] }, serve: fn => { handler = fn; } },
    fetch: async (url, options = {}) => {
      calls.push({ kind: 'fetch', url: String(url), options });
      if (String(url) === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
        return Response.json({ success: true, hostname: '', metadata: { result_with_testing_key: true } });
      }
      if (String(url).startsWith('https://db.example.test/rest/v1/rpc/')) {
        return Response.json({ ok: true, id: ID });
      }
      throw new Error('Unexpected network request');
    },
  });
  const cache = new Map();
  function load(filename) {
    const resolved = path.resolve(filename);
    if (!resolved.startsWith(root + path.sep)) throw new Error('Unexpected module path');
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    if (!compiledCache.has(resolved)) compiledCache.set(resolved, ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      fileName: resolved.replace(/\.mjs$/, '.ts'),
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    const compiled = compiledCache.get(resolved);
    const execute = vm.runInContext('(function(require,module,exports){\n' + compiled + '\n})', sandbox, { filename: resolved, timeout: 1000 });
    execute(specifier => {
      if (specifier === 'npm:@supabase/supabase-js@2.111.0') return {
        createClient: (...args) => { clients.push(args); return serviceClient; },
      };
      if (!specifier.startsWith('.')) throw new Error('Unexpected external module: ' + specifier);
      return load(path.resolve(path.dirname(resolved), specifier));
    }, module, module.exports);
    return module.exports;
  }
  load(path.join(root, name, 'index.ts'));
  if (typeof handler !== 'function') throw new Error('Production handler not registered');
  return { handler, calls, clients, load, serviceClient, errorLogs };
}

function request(name, { origin = HOSTED, base = 'https://edge.example.test', method = 'POST', headers = {}, body = {} } = {}) {
  const suffix = name === 'public-shipment-tracking' ? '/session' : '';
  return new Request(base + '/functions/v1/' + name + suffix, {
    method,
    headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json', 'x-real-ip': '203.0.113.4', ...headers },
    ...(['POST', 'PUT', 'PATCH'].includes(method) ? { body: JSON.stringify({ email: 'person@example.test', company: 'Example', full_name: 'Person', organization_name: 'Example', token: ID, ...body }) } : {}),
  });
}

describe('driver public entry routing', () => {
  test.each([null, [], 'scalar', false, {ok:false}, {ok:true}, {ok:true,organization_id:'bad',organization_slug:'owned'}])('rejects malformed or denied entry %j', async entryResult => {
    const app=loadHandler('driver-signup-intake',{entryResult});
    const response=await app.handler(request('driver-signup-intake',{body:{entry_key:'owned-entry'}}));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({error:{code:'public_entry_not_allowed'}});
    expect(app.calls.some(c=>c.name==='marketplace_participant_request_create_v1')).toBe(false);
  });
  test.each(['organization_id','requested_organization_id','organization_slug'])('rejects conflicting %s', async key=>{
    const app=loadHandler('driver-signup-intake');
    const response=await app.handler(request('driver-signup-intake',{body:{entry_key:'owned-entry',[key]:'foreign'}}));
    expect(response.status).toBe(403);
    expect(app.calls.some(c=>c.name==='marketplace_participant_request_create_v1')).toBe(false);
  });
  test('uses mapped tenant for compliance and pending sink without provisioning',async()=>{
    const app=loadHandler('driver-signup-intake');
    const response=await app.handler(request('driver-signup-intake',{body:{entry_key:'owned-entry'}}));
    expect(response.status).toBe(200);
    expect(app.calls).toContainEqual({kind:'rpc',name:'marketplace_public_entry_resolve_v1',
      input:{p_entry_key:'owned-entry',p_participant_type_key:'freelancer_driver'}});
    expect(app.calls).toContainEqual({kind:'rpc',name:'marketplace_compliance_policy_v1',
      input:{p_context:{participant_type_key:'freelancer_driver',organization_id:ID}}});
    expect(app.calls.find(c=>c.name==='marketplace_participant_request_create_v1').input)
      .toMatchObject({p_requested_organization_id:ID,p_organization_slug:'owned-entry-org',p_requested_by_user_id:null});
    expect(app.calls.some(c=>c.kind==='invite')).toBe(false);
  });
  test('valid entry still reaches mandatory Turnstile denial',async()=>{
    const app=loadHandler('driver-signup-intake',{policy:{turnstile:{required:true}}});
    const response=await app.handler(request('driver-signup-intake',{body:{entry_key:'owned-entry'}}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({error:{code:'turnstile_required'}});
    expect(app.calls.some(c=>c.name==='marketplace_participant_request_create_v1')).toBe(false);
  });
});

describe('driver status sanitized failure diagnostics', () => {
  test.each([
    [true, 'email', 'email'],
    [true, 'phone', 'phone'],
    [true, 'employee_or_contractor_id', 'employee_or_contractor_id'],
    [true, 'PRIVATE_customer_contact', ''],
    [true, null, ''],
    [true, { email: 'PRIVATE_customer_contact' }, ''],
    [false, 'email', ''],
    ['true', 'email', ''],
  ])('driver intake returns only canonical deduplication classifications (%s,%s)', async (deduped, reason, expected) => {
    const app = loadHandler('driver-signup-intake', { env: {
      DRIVER_SIGNUP_CORS_ALLOW_ORIGINS: HOSTED,
      DRIVER_SIGNUP_IP_HASH_SALT: 'fixture-driver-salt',
    } });
    const originalRpc = app.serviceClient.rpc;
    const createCalls = [];
    app.serviceClient.rpc = async (name, input) => {
      if (name !== 'marketplace_participant_request_create_v1') return originalRpc(name, input);
      createCalls.push(input);
      return { data: { ok: true, id: ID, status: 'pending', deduped,
        dedupe_reason: reason, application_status_token: 'fixture-status-token' }, error: null };
    };
    const response = await app.handler(request('driver-signup-intake'));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(HOSTED);
    const body = await response.json();
    expect(body).toEqual({ ok: true, id: ID, status: 'pending', deduped: Boolean(deduped),
      dedupe_reason: expected, application_status_token: 'fixture-status-token' });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({ p_requested_participant_type_key: 'freelancer_driver',
      p_requested_organization_id: ID, p_requested_by_user_id: null, p_turnstile_verified: false });
    expect(createCalls[0].p_ip_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_customer_contact');
  });

  test.each([
    [{data:null,error:{code:'42501',message:'PRIVATE',details:'PRIVATE'}},400,'rpc_error','42501','absent',false,false],
    [{data:null,error:{code:'PRIVATE',message:'PRIVATE'}},400,'rpc_error','unclassified','absent',false,false],
    [{data:[],error:null},400,'result_contract','unclassified','array',false,false],
    [{data:{ok:true,status:'PRIVATE'},error:null},400,'result_contract','unclassified','object',true,false],
    [{data:{ok:false,error:{code:'request_not_found'}},error:null},404,'result_contract','unclassified','object',false,false],
  ])('classifies failure without disclosing RPC data', async (rpcResult,status,category,code,shape,ok,allowed) => {
    const app=loadHandler('driver-application-status');
    app.serviceClient.rpc=async()=>rpcResult;
    const response=await app.handler(request('driver-application-status'));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ok:false,error:{code:status===404?'request_not_found':'request_failed'}});
    expect(app.errorLogs).toHaveLength(1);
    expect(app.errorLogs[0]).not.toContain('PRIVATE');
    expect(app.errorLogs[0]).not.toContain(ID);
    expect(JSON.parse(app.errorLogs[0])).toMatchObject({event:'driver_application_status_readback_failed',
      failure_category:category,rpc_error_code:code,result_shape:shape,result_ok:ok,status_allowed:allowed});
  });
  test('successful pending status stays200 without a failure log', async () => {
    const app=loadHandler('driver-application-status');
    const response=await app.handler(request('driver-application-status'));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('pending');
    expect(app.errorLogs).toEqual([]);
  });
});

describe.each(facades)('%s browser-only CORS entrypoint', (name, envKey) => {
  test.each([
    ['missing origin', { origin: '' }, {}, 403, 'origin_required'],
    ['credential origin', { origin: (['https',":","/","/",'u',":",'p',"@",'landing.example.test'].join("")) }, {}, 403, 'origin_not_allowed'],
    ['path origin', { origin: HOSTED + '/path' }, {}, 403, 'origin_not_allowed'],
    ['denied origin', { origin: 'https://evil.example.test' }, {}, 403, 'origin_not_allowed'],
    ['HTTP hosted config', {}, { [envKey]: 'http://landing.example.test' }, 500, 'server_misconfigured'],
    ['wildcard config', {}, { [envKey]: '*' }, 500, 'server_misconfigured'],
    ['credential config', {}, { [envKey]: (['https',":","/","/",'u',":",'p',"@",'landing.example.test'].join("")) }, 500, 'server_misconfigured'],
    ['path config', {}, { [envKey]: HOSTED + '/path' }, 500, 'server_misconfigured'],
    ['invalid config', {}, { [envKey]: 'not-an-origin' }, 500, 'server_misconfigured'],
    ['missing config', {}, { MARKETING_CORS_ALLOW_ORIGINS: '', [envKey]: '' }, 500, 'server_misconfigured'],
    ['local Origin spoof', { origin: LOCAL }, { PUBLIC_EDGE_LOCAL_QA_ENABLED: '1', PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: LOCAL }, 403, 'origin_not_allowed'],
    ['local Host spoof', { origin: LOCAL, headers: { host: '127.0.0.1', 'x-forwarded-host': 'localhost' } }, { PUBLIC_EDGE_LOCAL_QA_ENABLED: '1', PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: LOCAL }, 403, 'origin_not_allowed'],
    ['local flag absent', { origin: LOCAL, base: 'http://127.0.0.1:54321' }, { PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: LOCAL }, 403, 'origin_not_allowed'],
    ['unlisted local origin', { origin: 'http://127.0.0.1:5299', base: 'http://127.0.0.1:54321' }, { PUBLIC_EDGE_LOCAL_QA_ENABLED: '1', PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: LOCAL }, 403, 'origin_not_allowed'],
    ['malformed hosted not rescued locally', { origin: LOCAL, base: 'http://127.0.0.1:54321' }, { [envKey]: '*', PUBLIC_EDGE_LOCAL_QA_ENABLED: '1', PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: LOCAL }, 500, 'server_misconfigured'],
    ['preflight method', { method: 'OPTIONS', headers: { 'access-control-request-method': 'DELETE' } }, {}, 403, 'method_not_allowed'],
    ['preflight header', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-unapproved' } }, {}, 403, 'headers_not_allowed'],
  ])('rejects %s before business effects', async (_label, options, env, status, code) => {
    const app = loadHandler(name, { env });
    const response = await app.handler(request(name, options));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, error: { code } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(app.calls).toEqual([]);
    expect(app.clients).toEqual([]);
  });

  test.each([
    ['hosted', HOSTED, 'https://edge.example.test', {}],
    ['leased local', LOCAL, 'http://127.0.0.1:54321', { PUBLIC_EDGE_LOCAL_QA_ENABLED: '1', PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: LOCAL }],
  ])('accepts configured %s preflight', async (_label, origin, base, env) => {
    const app = loadHandler(name, { env });
    const response = await app.handler(request(name, { origin, base, method: 'OPTIONS', headers: {
      'access-control-request-method': 'POST', 'access-control-request-headers': 'accept, content-type, apikey',
    } }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('vary')).toContain('Access-Control-Request-Headers');
    expect(app.calls).toEqual([]);
  });

  test('accepted hosted POST retains current RPC and service-key/API-schema path', async () => {
    const app = loadHandler(name);
    const response = await app.handler(request(name));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(HOSTED);
    expect((await response.json()).ok).toBe(true);
    if (name === 'marketing-lead-intake') {
      const call = app.calls.find(call => call.kind === 'fetch');
      expect(call.url).toContain('/marketing_lead_request_create_v1');
      expect(call.options.headers.authorization).toBe('Bearer sb_secret_fixture');
    } else {
      expect(app.clients[0][2]).toMatchObject({ db: { schema: 'api' }, global: { headers: { apikey: 'sb_secret_fixture' } } });
      expect(app.calls.some(call => call.kind === 'rpc')).toBe(true);
    }
  });
});

describe('local fallback authority and tenant response contract', () => {
  test.each(['marketing-lead-intake', 'public-shipment-tracking', 'tenant-signup-intake'])(
    '%s cannot use local IP/salt fallback for accepted hosted origin on loopback URL', async name => {
      const app = loadHandler(name, { env: { MARKETING_IP_HASH_SALT: '', PUBLIC_EDGE_LOCAL_QA_ENABLED: '1', PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: LOCAL } });
      const response = await app.handler(request(name, { base: 'http://127.0.0.1:54321', headers: { 'x-real-ip': '' } }));
      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe('server_misconfigured');
      expect(app.calls.filter(call => call.kind === 'fetch')).toEqual([]);
    },
  );

  test('marketing exact local test tuple still avoids Siteverify', async () => {
    const name = 'marketing-lead-intake';
    const app = loadHandler(name, { env: { MARKETING_IP_HASH_SALT: '', PUBLIC_EDGE_LOCAL_QA_ENABLED: '1', PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: LOCAL } });
    const response = await app.handler(request(name, { origin: LOCAL, base: 'http://127.0.0.1:54321', headers: { 'x-real-ip': '' }, body: { turnstile_token: 'EXAMPLE_PASSWORD' } }));
    expect(response.status).toBe(200);
    expect(app.calls.filter(call => call.kind === 'fetch')).toHaveLength(1);
    expect(app.calls[0].url).toContain('/marketing_lead_request_create_v1');
  });

  test.each([
    ['default manual', {}, {}, 'under_review', false],
    ['explicit status', { status: 'pending' }, {}, 'pending', false],
    ['successful auto approval', { status: 'pending', auto_approve: true }, { ok: true, status: 'approved' }, 'approved', true],
    ['unsuccessful auto approval', { status: 'pending', auto_approve: true }, { ok: false }, 'pending', false],
  ])('%s returns canonical queue status in both projections', async (_label, createResult, approvalResult, status, applied) => {
    const app = loadHandler('tenant-signup-intake', { createResult, approvalResult });
    const response = await app.handler(request('tenant-signup-intake'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status, queue_status: status, auto_approve_applied: applied });
  });
});

describe('metrics handler explicit enablement (native JWT gate not simulated)', () => {
  const token = (role, overrides = {}) => 'fixture.' + Buffer.from(JSON.stringify({
    role, aud: 'authenticated', sub: 'edge-function', exp: Math.floor(Date.now() / 1000) + 3600, ...overrides,
  })).toString('base64url') + '.fixture';
  test.each([undefined, '', '0', 'true', 'yes'])('flag %s is default off before business auth', async flag => {
    const app = loadHandler('metrics-echo-test', { env: { METRICS_ECHO_TEST_ENABLED: flag } });
    expect((await app.handler(request('metrics-echo-test', { method: 'GET' }))).status).toBe(404);
    expect(app.calls).toEqual([]);
  });
  test.each([['GET', 204], ['POST', 200]])('enabled authenticated %s retains behavior', async (method, status) => {
    const app = loadHandler('metrics-echo-test', { env: { METRICS_ECHO_TEST_ENABLED: '1' } });
    const response = await app.handler(request('metrics-echo-test', { method, headers: { authorization: 'Bearer ' + token('edge_api_caller_role') } }));
    expect(response.status).toBe(status);
    if (method === 'POST') expect(await response.json()).toMatchObject({ ok: true, received: { company: 'Example' } });
  });
  test.each([['', 401], ['authenticated', 403]])('enabled unauthorized role %s remains denied', async (role, status) => {
    const app = loadHandler('metrics-echo-test', { env: { METRICS_ECHO_TEST_ENABLED: '1' } });
    expect((await app.handler(request('metrics-echo-test', { method: 'GET', headers: role ? { authorization: 'Bearer ' + token(role) } : {} }))).status).toBe(status);
  });

  test.each([
    ['missing expiry', {}, { exp: undefined }, 401],
    ['expired', {}, { exp: 0 }, 401],
    ['non-numeric expiry', {}, { exp: 'invalid' }, 401],
    ['future activation', {}, { nbf: 9999999999 }, 401],
    ['non-numeric activation', {}, { nbf: 'invalid' }, 401],
    ['missing audience', {}, { aud: undefined }, 403],
    ['wrong audience', {}, { aud: 'other' }, 403],
    ['missing subject', {}, { sub: undefined }, 403],
    ['wrong subject', {}, { sub: 'other' }, 403],
    ['service wrong audience', { role: 'service_role' }, { aud: 'other' }, 403],
    ['service wrong subject', { role: 'service_role' }, { sub: 'other' }, 403],
  ])('rejects %s before metrics business response', async (_name, options, claims, status) => {
    const app = loadHandler('metrics-echo-test', { env: { METRICS_ECHO_TEST_ENABLED: '1' } });
    const response = await app.handler(request('metrics-echo-test', {
      method: 'POST', headers: { authorization: 'Bearer ' + token(options.role || 'edge_api_caller_role', claims) },
    }));
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty('received');
    expect(app.calls).toEqual([]);
  });
  test.each([
    ['edge_api_caller_role', { aud: ['other', 'authenticated'], nbf: 0 }],
    ['service_role', { aud: undefined, sub: undefined }],
    ['service_role', { aud: 'authenticated', sub: 'edge-function' }],
  ])('preserves valid current shared-policy claims for %s', async (role, claims) => {
    const app = loadHandler('metrics-echo-test', { env: { METRICS_ECHO_TEST_ENABLED: '1' } });
    const response = await app.handler(request('metrics-echo-test', {
      method: 'GET', headers: { authorization: 'Bearer ' + token(role, claims) },
    }));
    expect(response.status).toBe(204);
  });

});

describe('hosted invite redirect enforcement through current callers', () => {
  test.each([
    ['https://console.example.test/invite#fragment', 'https://console.example.test/invite'],
    ['http://console.example.test/invite', ''],
    ['https://localhost/invite', ''],
    ['https://internal.local/invite', ''],
    ['javascript:alert(1)', ''],
  ])('normalizes or rejects %s', (input, expected) => {
    const app = loadHandler('tenant-signup-intake');
    const helper = app.load(path.join(root, '_shared/tenant_signup.ts'));
    expect(helper.normalizeHostedRedirectUrl(input)).toBe(expected);
  });

  test.each(['tenant', 'marketplace'])('%s approval rejects HTTP before auth provisioning', async kind => {
    const app = loadHandler('tenant-signup-intake', { policy: { onboarding: { invite_redirect_to: 'http://console.example.test/invite' } } });
    const helper = app.load(path.join(root, '_shared/' + (kind === 'tenant' ? 'tenant_signup.ts' : 'marketplace_signup.ts')));
    const serviceClient = app.serviceClient;
    const approve = kind === 'tenant' ? helper.approveTenantSignupRequest : helper.approveMarketplaceParticipantRequest;
    expect(await approve({ serviceClient, requestId: ID, reviewerUserId: null })).toMatchObject({
      ok: false, error: { code: 'invite_redirect_required' },
    });
    expect(app.calls.some(call => call.kind === 'invite')).toBe(false);
    expect(app.calls.some(call => call.name?.endsWith('review_apply_v1'))).toBe(false);
  });

  test('review override rejects HTTP before reviewer or service client access', async () => {
    const app = loadHandler('tenant-signup-review');
    const response = await app.handler(request('tenant-signup-review', {
      headers: { authorization: 'Bearer fixture-review-token' },
      body: { request_id: ID, decision: 'approved', invite_redirect_to: 'http://console.example.test/invite' },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_invite_redirect_to' } });
    expect(app.clients).toEqual([]);
    expect(app.calls).toEqual([]);
  });
});
