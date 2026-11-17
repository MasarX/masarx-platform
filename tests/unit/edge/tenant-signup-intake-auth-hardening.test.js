const fs = require('fs');
const path = require('path');

describe('tenant-signup-intake auth hardening', () => {
  const functionPath = path.join(
    __dirname,
    '../../../supabase/functions/tenant-signup-intake/index.ts',
  );
  const source = fs.readFileSync(functionPath, 'utf8');

  test.each(['tenant-signup-intake', 'driver-signup-intake'])('%s preserves JSON page context behind existing security checks', (name) => {
    const handler = fs.readFileSync(path.join(__dirname, '../../../supabase/functions', name, 'index.ts'), 'utf8');
    expect(handler).toContain('page_url?: unknown;');
    expect(handler).toContain('asString(payload?.page_url) || cors.origin');
    expect(handler).not.toContain('searchParams.get("page_url")');
    const mutation = handler.indexOf(name === 'tenant-signup-intake' ? '"tenant_signup_request_create_v1"' : '"marketplace_participant_request_create_v1"');
    expect(mutation).toBeGreaterThan(handler.indexOf('if (turnstileRequired && !turnstileVerified)'));
    expect(handler).toContain('serviceClient.rpc(');
  });


  test.each([
    [true, '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830', true],
    [false, '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830', false],
    [true, 'invalid', false],
  ])('actual observation preserves operations (local=%s, correlation=%s)', async (localContext, correlation, emits) => {
    const ts = require('typescript');
    const ast = ts.createSourceFile(functionPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = new Map();
    const visit = node => {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && ['correlation','observeStages','observe'].includes(declaration.name.text)) {
            expect(declarations.has(declaration.name.text)).toBe(false);
            declarations.set(declaration.name.text, node.getText(ast));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect([...declarations.keys()]).toEqual(['correlation','observeStages','observe']);
    const js = ts.transpileModule([...declarations.values()].join('\n'), {
      compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
    }).outputText;
    const logger = {info:jest.fn()};
    const observe = new Function('req','cors','performance','console',js+';return observe;')(
      {headers:{get:()=>correlation}}, {localContext}, {now:()=>10}, logger);
    const value = {};
    const operation = jest.fn(async()=>value);
    await expect(observe('policy',operation)).resolves.toBe(value);
    expect(operation).toHaveBeenCalledTimes(1);
    const failure = new Error('PRIVATE');
    await expect(observe('turnstile',async()=>{throw failure;})).rejects.toBe(failure);
    expect(logger.info).toHaveBeenCalledTimes(emits ? 4 : 0);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('PRIVATE');
    if(emits) expect(logger.info.mock.calls.map(([line])=>JSON.parse(line).status))
      .toEqual(['started','resolved','started','rejected']);
    logger.info.mockImplementation(()=>{throw new Error('logger failed');});
    await expect(observe('persistence',async()=>value)).resolves.toBe(value);
    await expect(observe('auto_approve',async()=>{throw failure;})).rejects.toBe(failure);
  });
  const loadServiceFactory = (createClient, overrides = {}) => {
    const ts = require('typescript');
    const ast = ts.createSourceFile(functionPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = ['isJwtLike', 'createServiceClient'];
    const helperPath = path.join(path.dirname(functionPath), '_shared/tenant_signup.ts');
    const helperAst = ts.createSourceFile(helperPath, fs.readFileSync(helperPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const helpers = helperAst.statements.filter(ts.isVariableStatement)
      .flatMap(node => [...node.declarationList.declarations])
      .filter(node => ts.isIdentifier(node.name) && node.name.text === 'asString');
    expect(helpers).toHaveLength(1);
    const helperJs = ts.transpileModule('const ' + helpers[0].getText(helperAst) + ';', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const asString = new Function(helperJs + ';return asString;')();
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
    const env = { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_KEY: 'service.fixture.jwt',
      SUPABASE_ANON_KEY: 'anon.fixture.jwt', EDGE_SUPABASE_SECRET_KEY: '', TENANT_SIGNUP_RPC_SCHEMA: 'api', ...overrides };
    return new Function(...Object.keys(env), 'createClient', 'asString', js + ';return createServiceClient;')(...Object.values(env), createClient, asString);
  };
  test.each([
    [{}, 'service.fixture.jwt', 'anon.fixture.jwt'],
    [{ SUPABASE_ANON_KEY: '' }, 'service.fixture.jwt', 'service.fixture.jwt'],
    [{ EDGE_SUPABASE_SECRET_KEY: 'sb_secret_fixture' }, 'sb_secret_fixture', 'sb_secret_fixture'],
  ])('actual tenant factory preserves API schema and key-plane headers (%j)', (overrides, key, apikey) => {
    const client = {};
    const createClient = jest.fn(() => client);
    expect(loadServiceFactory(createClient, overrides)()).toBe(client);
    expect(createClient).toHaveBeenCalledWith('https://fixture.invalid', key,
      { auth: { persistSession: false }, db: { schema: 'api' }, global: { headers: { apikey } } });
  });
  test.each([{ SUPABASE_URL: '' }, { SUPABASE_SERVICE_KEY: '' }])('actual tenant factory fails closed before construction (%j)', overrides => {
    const createClient = jest.fn();
    expect(loadServiceFactory(createClient, overrides)).toThrow('missing_supabase_configuration');
    expect(createClient).not.toHaveBeenCalled();
  });

  test('supports secret-key fallback env for edge runtime', () => {
    expect(source).toContain('const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [');
    expect(source).toContain('"SUPABASE_SECRET_KEY"');
  });

  test('uses dynamic apikey header for JWT-vs-secret key compatibility', () => {
    expect(source).toContain('const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;');
    expect(source).toContain('const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);');
    expect(source).toContain('const apiKeyHeader = isJwtLike(serviceKey)');
    expect(source).toContain('? (anonKey || serviceKey)');
    expect(source).toContain(': serviceKey;');
    expect(source).toContain('apikey: apiKeyHeader');
  });

  test("local browser authority uses the shared configured-origin adapter", () => {
    expect(source).toContain("resolveBrowserCorsPolicy(req, {");
    expect(source).toContain('localQaEnabled: readEnv("PUBLIC_EDGE_LOCAL_QA_ENABLED") === "1"');
    expect(source).toContain('localAllowedOrigins: readEnv("PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS")');
    expect(source).not.toContain("localFallbackOrigins.add(origin)");
    expect(source).not.toContain("x-forwarded-host");
  });
});
