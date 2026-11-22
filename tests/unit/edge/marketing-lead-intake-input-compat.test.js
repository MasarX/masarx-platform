const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

describe('marketing-lead-intake payload compatibility', () => {
  const functionPath = path.join(
    __dirname,
    '../../../supabase/functions/marketing-lead-intake/index.ts',
  );
  const source = fs.readFileSync(functionPath, 'utf8');
  const turnstileVerifierPath = path.join(
    __dirname,
    '../../../supabase/functions/marketing-lead-intake/turnstile-local-test.mjs',
  );
  const rpcAuthPath = path.join(
    __dirname,
    '../../../supabase/functions/marketing-lead-intake/rpc-auth.mjs',
  );
  let turnstileVerifier;
  let selectRpcAuthAttempts;

  beforeAll(async () => {
    turnstileVerifier = await import(pathToFileURL(turnstileVerifierPath).href);
    ({ selectRpcAuthAttempts } = await import(pathToFileURL(rpcAuthPath).href));
  });

  const loadRpc = async (fetch, overrides = {}) => {
    const ts = require('typescript');
    const ast = ts.createSourceFile(functionPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = ['asString', 'isJwtLike', 'extractRpcMessage', 'isRetryableAuthError', 'buildRpcAuthAttempts', 'invokeRpcWithAuthFallback'];
    const declarations = new Map();
    for (const node of ast.statements) {
      if (!ts.isVariableStatement(node)) continue;
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)) {
          expect(declarations.has(declaration.name.text)).toBe(false);
          declarations.set(declaration.name.text, node.getText(ast));
        }
      }
    }
    expect([...declarations.keys()]).toEqual(names);
    const js = ts.transpileModule([...declarations.values()].join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const { toResponseBody } = await import(pathToFileURL(path.join(path.dirname(functionPath), '../_shared/mod.mjs')).href);
    const env = { SUPABASE_URL: 'https://fixture.invalid', DB_JWT: 'edge.fixture.jwt',
      SUPABASE_SERVICE_KEY: 'service.fixture.jwt', SUPABASE_ANON_KEY: '', EDGE_SUPABASE_SECRET_KEY: '', ...overrides };
    return new Function(...Object.keys(env), 'fetch', 'selectRpcAuthAttempts', 'toResponseBody',
      js + ';return invokeRpcWithAuthFallback;')(...Object.values(env), fetch, selectRpcAuthAttempts, toResponseBody);
  };
  const assertApiRequests = (fetch, rpc) => {
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe(`https://fixture.invalid/rest/v1/rpc/${rpc}`);
      expect(init.method).toBe('POST');
      expect(init.headers['accept-profile']).toBe('api');
      expect(init.headers['content-profile']).toBe('api');
    }
  };
  test('actual marketing mutation pins API profiles and excludes the edge JWT', async () => {
    const fetch = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const invoke = await loadRpc(fetch);
    await invoke('marketing_lead_request_create_v1', { p_email: 'fixture@example.test' }, { serviceOnly: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    assertApiRequests(fetch, 'marketing_lead_request_create_v1');
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer service.fixture.jwt');
  });
  test.each([
    ['marketing_lead_request_create_v1', { serviceOnly: true }],
    ['marketing_landing_clients_list_v1', {}],
  ])('dedicated marketing auth never retries %s with service credentials', async (rpc, options) => {
    const fetch = jest.fn().mockResolvedValue(new Response('{"message":"invalid signature"}', { status: 401 }));
    const invoke = await loadRpc(fetch, {
      DB_JWT: { marketing: 'marketing.fixture.jwt' },
      SUPABASE_ANON_KEY: 'public-fixture-key',
    });
    expect((await invoke(rpc, {}, options)).response.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
    assertApiRequests(fetch, rpc);
    expect(fetch.mock.calls[0][1].headers).toMatchObject({
      authorization: 'Bearer marketing.fixture.jwt',
      apikey: 'public-fixture-key',
    });
  });

  test('actual marketing read retains API profiles across auth fallback', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(new Response('{"message":"invalid signature"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const invoke = await loadRpc(fetch);
    await invoke('marketing_landing_clients_list_v1', {});
    expect(fetch).toHaveBeenCalledTimes(2);
    assertApiRequests(fetch, 'marketing_landing_clients_list_v1');
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer edge.fixture.jwt');
  });
  test('actual marketing mutation rejects edge-only credentials before transport', async () => {
    const fetch = jest.fn();
    const invoke = await loadRpc(fetch, { SUPABASE_SERVICE_KEY: '' });
    await expect(invoke('marketing_lead_request_create_v1', {}, { serviceOnly: true })).rejects.toThrow('missing_supabase_credentials');
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each([
    [422, 'invalid input'],
    [403, 'permission denied for function marketing_landing_clients_list_v1'],
  ])('actual marketing RPC does not retry application rejection %s', async (status, message) => {
    const fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ message }), { status }));
    const invoke = await loadRpc(fetch);
    const result = await invoke('marketing_landing_clients_list_v1', {});
    expect(result.response.status).toBe(status);
    expect(fetch).toHaveBeenCalledTimes(1);
    assertApiRequests(fetch, 'marketing_landing_clients_list_v1');
  });

  test('retains optional contact identity metadata without widening the service-only mutation plane', () => {
    expect(source).toContain('full_name?: unknown;');
    expect(source).toContain('website_url?: unknown;');
    expect(source).toContain('...(asString(payload?.full_name) ? { full_name: asString(payload.full_name) } : {})');
    expect(source).toContain('...(asString(payload?.website_url) ? { website_url: asString(payload.website_url) } : {})');
    expect(source).toContain('}, { serviceOnly: true });');
  });

  test('accepts organization_name aliases for company', () => {
    expect(source).toContain('organization_name?: unknown;');
    expect(source).toContain('organizationName?: unknown;');
    expect(source).toContain('asString(payload?.company) || asString(payload?.organization_name) || asString(payload?.organizationName)');
  });

  test('expands JWT auth attempts across anon/service api key planes', () => {
    expect(source).toContain('const apiKeyCandidates = [anonKey, asString(EDGE_SUPABASE_SECRET_KEY), asString(SUPABASE_SERVICE_KEY)]');
    expect(source).toContain('if (status !== 400 && status !== 401 && status !== 403) return false;');
    expect(source).toContain('addAttempt("db-jwt", {');
    expect(source).toContain('addAttempt(`db-jwt+apikey:${apiKey === anonKey ? "anon" : "service"}`, {');
    expect(source).toContain('addAttempt("service-jwt", {');
    expect(source).toContain('addAttempt(`service-jwt+apikey:${apiKey === anonKey ? "anon" : "service"}`, {');
    expect(source).toContain('addAttempt("service-secret-bearer+apikey", {');
    expect(source).toContain('message.includes("no api key")');
  });

  test('pins PostgREST RPC calls to the exposed api schema', () => {
    expect(source).toContain('"accept-profile": "api"');
    expect(source).toContain('"content-profile": "api"');
    expect(source).toContain('fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`');
  });

  test('resolves the canonical edge URL from configured runtime sources', () => {
    expect(source).toContain('const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);');
  });

  test('keeps lead mutation service-only while clients may use the edge DB JWT', () => {
    const attempts = [
      { label: 'db-jwt', headers: { authorization: 'Bearer edge-db' } },
      { label: 'db-jwt+apikey:anon', headers: { authorization: 'Bearer edge-db', apikey: 'anon' } },
      { label: 'service-jwt', headers: { authorization: 'Bearer service' } },
    ];
    expect(selectRpcAuthAttempts(attempts, false)).toEqual(attempts);
    expect(selectRpcAuthAttempts(attempts, true)).toEqual([attempts[2]]);
    expect(selectRpcAuthAttempts(attempts.slice(0, 2), true)).toEqual([]);
    expect(source).toContain('throw new Error("missing_supabase_credentials")');
    expect(source).toContain('}, { serviceOnly: true });');
    expect(source).toContain('invokeRpcWithAuthFallback("marketing_landing_clients_list_v1"');
  });

  test('tenant signup grants are inert because the handler uses a service client for policy and mutation', () => {
    const tenantSource = fs.readFileSync(
      path.join(__dirname, '../../../supabase/functions/tenant-signup-intake/index.ts'),
      'utf8',
    );
    expect(tenantSource).toContain('const createServiceClient = () =>');
    expect(tenantSource).toContain('policy = await observe("policy", () => loadTenantSignupPolicy(serviceClient));');
    expect(tenantSource).toContain('await serviceClient.rpc(');
  });

  test('accepts the exact local Turnstile test tuple without network egress', async () => {
    expect(source).toContain('requestHostname: requestUrl.hostname');
    const fetchImpl = jest.fn();
    const result = await turnstileVerifier.verifyMarketingTurnstile({
      localContext: true,
      requestHostname: '127.0.0.1',
      secret: turnstileVerifier.LOCAL_MARKETING_TURNSTILE_TEST_SECRET,
      token: turnstileVerifier.LOCAL_MARKETING_TURNSTILE_TEST_TOKEN,
      clientIp: '127.0.0.1',
      fetchImpl,
    });

    expect(result).toEqual({ success: true, hostname: '127.0.0.1', errorCodes: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['non-local context', false, '127.0.0.1', 'EXAMPLE_PASSWORD', 'EXAMPLE_PASSWORD'],
    ['non-loopback request URL', true, 'vomhkplympywspxymnstltsw.example.invalid', 'EXAMPLE_PASSWORD', 'EXAMPLE_PASSWORD'],
    ['non-test secret', true, '127.0.0.1', 'not-the-official-test-secret', 'EXAMPLE_PASSWORD'],
    ['non-test token', true, '127.0.0.1', 'EXAMPLE_PASSWORD', 'not-the-dummy-token'],
  ])('keeps Siteverify for %s', async (_label, localContext, requestHostname, secret, token) => {
    const fetchImpl = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        success: false,
        hostname: '',
        'error-codes': ['invalid-input-response'],
      }),
    });

    const result = await turnstileVerifier.verifyMarketingTurnstile({
      localContext,
      requestHostname,
      secret,
      token,
      clientIp: '127.0.0.1',
      fetchImpl,
    });

    expect(result).toEqual({
      success: false,
      hostname: '',
      errorCodes: ['invalid-input-response'],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('fails closed without a Turnstile secret', async () => {
    const fetchImpl = jest.fn();
    const result = await turnstileVerifier.verifyMarketingTurnstile({
      localContext: true,
      requestHostname: '127.0.0.1',
      secret: '',
      token: turnstileVerifier.LOCAL_MARKETING_TURNSTILE_TEST_TOKEN,
      fetchImpl,
    });

    expect(result).toEqual({
      success: false,
      hostname: '',
      errorCodes: ['missing_turnstile_secret'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('marketing database credential boundary', () => {
  const hosted = 'https://landing.example.test';
  const local = 'http://127.0.0.1:5199';
  const serviceSecret = 'sb_secret_marketing_fixture';
  let compiled;
  let modules;

  beforeAll(async () => {
    const ts = require('typescript');
    const root = path.join(__dirname, '../../../supabase/functions/marketing-lead-intake');
    compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'index.ts'), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const names = ['./_shared/cors.mjs', './_shared/mod.mjs', './_shared/turnstile-local-test.mjs', './rpc-auth.mjs'];
    modules = Object.fromEntries(await Promise.all(names.map(async name => [
      name, await import(pathToFileURL(path.resolve(root, name)).href),
    ])));
  });

  function loadHandler() {
    const env = {
      EDGE_SUPABASE_URL: 'https://db.example.test',
      EDGE_SUPABASE_ANON_KEY: 'fixture.anon.jwt',
      EDGE_SUPABASE_SECRET_KEY: serviceSecret,
      MARKETING_CORS_ALLOW_ORIGINS: hosted,
      PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: local,
      PUBLIC_EDGE_LOCAL_QA_ENABLED: '1',
    };
    const net = jest.fn().mockResolvedValue(new Response('[]'));
    const console = { warn: jest.fn(), error: jest.fn() };
    const mod = { ...modules['./_shared/mod.mjs'], readEnv: jest.fn((key, aliases = []) =>
      [key, ...aliases].map(name => env[name]).find(Boolean) || '') };
    let handler;
    new Function('exports', 'require', 'Deno', 'fetch', 'console', compiled)(
      {}, name => name === './_shared/mod.mjs' ? mod : modules[name],
      { serve: value => { handler = value; } }, net, console,
    );
    return { handler, net, console };
  }

  test('local loopback clients can use legacy credentials and warn without logging the secret', async () => {
    const { handler, net, console } = loadHandler();
    const response = await handler(new Request('http://127.0.0.1:54321/functions/v1/marketing-lead-intake/clients', {
      headers: { origin: local },
    }));
    expect(response.status).toBe(200);
    expect(net).toHaveBeenCalledTimes(1);
    expect(net.mock.calls[0][1].headers.authorization).toBe(`Bearer ${serviceSecret}`);
    expect(console.warn.mock.calls).toEqual([['[marketing-lead-intake] using local database credential fallback']]);
  });

  test.each(['GET', 'POST'])('hosted %s fails closed without a token despite loopback forwarding headers', async method => {
    const { handler, net, console } = loadHandler();
    const suffix = method === 'GET' ? '/clients' : '';
    const response = await handler(new Request(`https://edge.example.test/functions/v1/marketing-lead-intake${suffix}`, {
      method, headers: { origin: hosted, 'x-forwarded-host': 'localhost', 'x-forwarded-for': '127.0.0.1' },
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'server_misconfigured' } });
    expect(net).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
