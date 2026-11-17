let fs;
let vm;
let ts;
let egress;
let runtimeModules;
beforeAll(async () => {
  fs = await import('node:fs');
  vm = await import('node:vm');
  ts = (await import('typescript')).default;
  egress = await import('../../../supabase/functions/api-caller/egress.mjs');
  runtimeModules = {
    './studio-mapping-preview.mjs': await import('../../../supabase/functions/integration-plugin-studio/studio-mapping-preview.mjs'),
    './studio-test-submit.mjs': await import('../../../supabase/functions/integration-plugin-studio/studio-test-submit.mjs'),
    './studio-test-readback.mjs': await import('../../../supabase/functions/integration-plugin-studio/studio-test-readback.mjs'),
  };
});

async function studio(rpc, moduleOverrides = {}) {
  let handler;
  const log = jest.fn();
  const context = vm.createContext({ Request, Response, Headers, URL, console,
    Deno: { serve: (callback) => { handler = callback; } } });
  const shared = {
    readEnv: (key) => key.endsWith('URL') ? 'https://project.supabase.co' : 'synthetic-anon',
    extractToken: () => 'synthetic-session', resolveCorrelationId: () => 'synthetic-correlation',
    resolveTraceContext: () => ({ traceparent: 'synthetic-trace', trace_id: 'synthetic-trace-id' }),
    logStructured: log, parseRequestBody: async (request) => ({ json: await request.json() }),
    buildErrorEnvelope: ({ code, message, details, correlationId }) => ({ error: { code, message, details }, correlation_id: correlationId }),
  };
  const dependency = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
  const projection = new vm.SourceTextModule(fs.readFileSync('supabase/functions/integration-plugin-studio/studio-response.mjs', 'utf8'), { context });
  const source = fs.readFileSync('supabase/functions/integration-plugin-studio/index.ts', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  expect(compiled.diagnostics).toEqual([]);
  const edgeModule = new vm.SourceTextModule(compiled.outputText, { context });
  await edgeModule.link((name) => name.startsWith('npm:') ? dependency({ createClient: () => ({ rpc }) })
    : name === '../api-caller/egress.mjs' ? dependency({ isPublicIpAddress: egress.isPublicIpAddress })
    : name === './studio-response.mjs' ? projection
    : runtimeModules[name] ? dependency({ ...runtimeModules[name], ...moduleOverrides[name] }) : dependency(shared));
  await edgeModule.evaluate();
  return { handler, log };
}

const request = (endpoint, body) => new Request(`https://edge.example.invalid/integration-plugin-studio/${endpoint}`, {
  method: 'POST', headers: { authorization: 'Bearer synthetic-session', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const base = { source_type: 'manual', plugin_kind: 'api', inbound_config: { route: { method: 'POST', path_template: '/example', body_sample: { token: 'synthetic-raw' } } } };
const tenant = '00000000-0000-4000-8000-000000000001';
const policy = { domain_allowlist: ['*.invalid'], domain_denylist: [], header_allowlist: ['content-type', 'x-provider-auth'] };
const client = (projection, runtimePreview = null) => jest.fn(async (name, args) => {
  if (name === 'integration_studio_preview_mapping_v1') return { data: runtimePreview, error: null };
  if (name === 'integration_plugin_validate_config_v1') return { data: true, error: null };
  if (name === 'integration_plugin_redact_projection_v1') return projection(args.p_value);
  if (name === 'ui_me_v1') return { data: { org: { id: tenant } }, error: null };
  if (name === 'ui_settings_preview_v1') return { data: { value: policy }, error: null };
  if (name === 'ui_create_mapping_operation_report_v1') return { data: { id: 'synthetic-report', token: 'synthetic-raw' }, error: null };
  return { data: null, error: null };
});

describe('current Studio handler final response boundary', () => {
  // SQL is deliberately stubbed here: native sanitizer semantics live in pgTAP.
  test('OpenAPI parse delegates credential extensions to the write boundary without changing identifiers', async () => {
    const document = { openapi: '3.0.0', 'x-api-key': 'sg40-raw', paths: { '/x-api-key': { post: {} } },
      webhooks: { 'x-api-key': { post: {} } },
      servers: [{ url: 'https://{x-api-key}.example.invalid', variables: { 'x-api-key': { default: 'public-reference' } } }],
      components: { schemas: { 'x-api-key': { description: 'Public key', maxLength: 64 } },
        links: { next: { parameters: { 'x-api-key': 'public-reference', session: 'Bearer sg40-raw', callback: 'https://example.invalid/?token=sg40-raw' } } },
        examples: { 'x-api-key': { value: { token: 'sg40-raw' } } } } };
    const rpc = client((payload) => {
      expect(payload.normalized_contract.route.path_template).toBe('/x-api-key');
      return { data: payload, error: null };
    });
    const { handler } = await studio(rpc);
    const response = await handler(request('parse', { source_type: 'openapi', source_payload: { openapi: document }, persist_draft: true }));
    expect(response.status).toBe(200);
    expect(rpc.mock.calls.find(([name]) => name === 'integration_plugin_generate_draft_v1')[1].p_source_payload).toEqual({ openapi: document });
    const body = await response.json();
    expect(body.normalized_contract.sample_schema.properties['x-api-key']).toEqual({ type: 'string' });
    expect(body.normalized_contract.sample_schema.properties.webhooks.properties).toHaveProperty('x-api-key');
    expect(JSON.stringify(body)).not.toContain('sg40-raw');
  });
  test.each([
    [String.raw`{"\u0074oken":"sg40-raw"}`, { token: 'sg40-raw' }],
    [String.raw`{"client\u005fsecret":"sg40-raw"}`, { client_secret: 'sg40-raw' }],
    [String.raw`{"\uZZZZoken":"sg40-raw"}`, String.raw`{"\uZZZZoken":"sg40-raw"}`],
  ])('curl parsing delegates decoded or malformed JSON %s to safe SQL boundaries', async (json, parsed) => {
    const curl = `curl https://example.invalid/sg40 -d '${json}'`;
    const rpc = client((payload) => {
      expect(payload.normalized_contract.route.body_sample).toEqual(parsed);
      return { data: { ok: payload.ok, normalized_contract: { ...payload.normalized_contract,
        route: { ...payload.normalized_contract.route, body_sample: 'REDACTED' } } }, error: null };
    });
    const { handler } = await studio(rpc);
    const response = await handler(request('parse', { source_type: 'curl', source_payload: { curl }, persist_draft: true }));
    expect(response.status).toBe(200);
    expect(rpc.mock.calls.find(([name]) => name === 'integration_plugin_generate_draft_v1')[1].p_source_payload).toEqual({ curl });
    expect(JSON.stringify(await response.json())).not.toContain('sg40-raw');
  });
  test.each([
    [{ fields: null, column_mappings: [{ target_field: ' reference ', source_path: 3, source_column: 'token' }] }, { reference: 'synthetic-raw' }, { reference: 'REDACTED' }],
    [{ fields: {}, column_mappings: [null, 3, [], { target_field: 'reference', source_path: ' $.token ' }] }, { reference: 'synthetic-raw' }, { reference: 'REDACTED' }],
    [{ fields: [], column_mappings: [{ target_field: 'reference', source_path: '$.token' }] }, {}, {}],
    [{ fields: [null, 3, []], column_mappings: [{ target_field: 'reference', source_path: '$.token' }] }, {}, {}],
    [{ fields: false, column_mappings: null, field_mappings: { ' reference ': [3, ' $.token ', null] } }, { reference: 'synthetic-raw' }, { reference: 'REDACTED' }],
    [{ field_mappings: { reference: [3, '$.public_token', '$.token'] } }, { reference: 'public-reference' }, { reference: 'public-reference' }],
    [{ fields: [{ target_field: 'reference', source_path: {}, source_column: ['token'] }] }, { reference: 'synthetic-raw' }, { reference: 'REDACTED' }],
    [{ fields: [{ target_field: '\t reference\u00a0', source_path: '\n $.token\ufeff' }] }, { reference: 'synthetic-raw' }, { reference: 'REDACTED' }],
    [{ fields: [{ target_field: 'reference', source_path: ' \t', source_column: 'token' }] }, { reference: 'synthetic-raw' }, { reference: 'REDACTED' }],
    [{ fields: [{ target_field: 3, source_path: '$.token' }, { target_field: ' ', source_path: '$.token' }] }, {}, {}],
    [{ fields: [{ target_field: 'reference', source_path: false, source_column: false, sample_value: 'public-reference' }] }, { reference: 'public-reference' }, { reference: 'public-reference' }],
    [{ fields: [{ target_field: 'reference', source_path: null, source_column: {}, sample_value: 'public-reference' }] }, { reference: 'public-reference' }, { reference: 'public-reference' }],
  ])('actual handler supplies normalized preview plus unchanged mapping case %#', async (mapping, preview, canonicalPreview) => {
    const rpc = client((payload) => {
      expect(payload.review.mapping_config).toEqual(mapping);
      expect(payload.review.coerced_preview).toEqual(preview);
      return { data: { ...payload, normalized_contract: { ...payload.normalized_contract,
        route: { ...payload.normalized_contract.route, body_sample: { token: 'REDACTED', public_token: 'public-reference' } } },
      review: { ...payload.review, coerced_preview: canonicalPreview } }, error: null };
    }, preview);
    const { handler } = await studio(rpc);
    const response = await handler(request('preview', { ...base, artifact: 'api_outbound', mapping_config: mapping,
      inbound_config: { route: { ...base.inbound_config.route, body_sample: { token: 'synthetic-raw', public_token: 'public-reference' } } } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review.mapping_config).toEqual(mapping);
    if (Object.prototype.hasOwnProperty.call(mapping, 'field_mappings')) {
      const runtimeCalls = rpc.mock.calls.filter(([name]) => name === 'integration_studio_preview_mapping_v1');
      expect(runtimeCalls).toHaveLength(1);
      expect(runtimeCalls[0][1]).toEqual({ p_source: { token: 'synthetic-raw', public_token: 'public-reference' },
        p_mapping_config: mapping });
    }
    expect(body.review.coerced_preview).toEqual(canonicalPreview);
    expect(JSON.stringify(body)).not.toContain('synthetic-raw');
  });
  test('infer carries untyped schema members and OpenAPI evidence to the shared final projection', async () => {
    const sampleSchema = { properties: { token: { description: 'Public tracking token', maxLength: 64 } } };
    const normalized = { source_type: 'openapi', plugin_kind: 'api', route: { method: 'POST', path_template: '/token' },
      sample_schema: sampleSchema, metadata: { server_url: 'https://example.invalid/?api_key=sg40-raw', description: 'Authorization: Bearer sg40-raw' } };
    const rpc = client((payload) => {
      expect(payload.normalized_contract).toEqual(normalized);
      return { data: { ...payload, normalized_contract: { ...normalized,
        metadata: { server_url: 'https://example.invalid/?api_key=REDACTED', description: 'Authorization: Bearer REDACTED' } } }, error: null };
    });
    const { handler } = await studio(rpc);
    const response = await handler(request('infer', { normalized_contract: normalized }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.normalized_contract.sample_schema).toEqual(sampleSchema);
    expect(JSON.stringify(body)).not.toContain('sg40-raw');
  });
  test('curl parsing and draft persistence retain raw inputs only until the SQL write/response boundaries', async () => {
    const curl = `curl https://example.invalid/sg40 -d '{"private_key":"sg40-raw","client_secret":"sg40-other"}'`;
    const rpc = client((payload) => {
      expect(payload.normalized_contract.route.body_sample).toEqual({ private_key: 'sg40-raw', client_secret: 'sg40-other' });
      return { data: { ok: payload.ok, normalized_contract: { ...payload.normalized_contract,
        route: { ...payload.normalized_contract.route, body_sample: { private_key: 'REDACTED', client_secret: 'REDACTED' } } } }, error: null };
    });
    const { handler } = await studio(rpc);
    const response = await handler(request('parse', { source_type: 'curl', source_payload: { curl }, persist_draft: true }));
    expect(response.status).toBe(200);
    expect(rpc.mock.calls.find(([name]) => name === 'integration_plugin_generate_draft_v1')[1].p_source_payload).toEqual({ curl });
    expect(JSON.stringify(await response.json())).not.toMatch(/sg40-(raw|other)/);
  });
  test.each([
    ['$.token', { token: 'synthetic-raw' }],
    ['$.token.nested', { token: { nested: 'synthetic-raw' } }],
    ['$.token[0]', { token: ['synthetic-raw'] }],
    ['$.token[*].nested', { token: [{ nested: 'synthetic-raw' }] }],
    ['column:token', { token: 'synthetic-raw' }],
  ])('manual uncoerced renamed preview retains %s provenance through the final projection', async (sourcePath, sample) => {
    const mapping = { fields: [{ target_field: 'reference', source_path: sourcePath }] };
    const rpc = client((payload) => {
      expect(payload.review).toMatchObject({ mapping_config: mapping, coerced_preview: { reference: 'synthetic-raw' }, coercions: [] });
      return { data: { ...payload, normalized_contract: { ...payload.normalized_contract,
        route: { ...payload.normalized_contract.route, body_sample: { token: 'REDACTED' } } },
      review: { ...payload.review, coerced_preview: { reference: 'REDACTED' } } }, error: null };
    });
    const { handler } = await studio(rpc);
    const response = await handler(request('preview', { ...base,
      inbound_config: { route: { ...base.inbound_config.route, body_sample: sample } },
      artifact: 'api_outbound', mapping_config: mapping, target_schema: { properties: { reference: { type: 'string' } } } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review.mapping_config).toEqual(mapping);
    expect(body.review.coercions).toEqual([]);
    expect(body.review.coerced_preview.reference).toBe('REDACTED');
    expect(JSON.stringify(body)).not.toContain('synthetic-raw');
  });
  test.each([['Bearer sg40-raw', false], ['Bearer {{provider.token}}', true]])('direct save delegates custom header %s to the shared executable guard', async (header, allowed) => {
    const config = { url_template: 'https://example.invalid/sg40', headers_template: { 'X-Provider-Auth': header }, body_template: { service: 'Basic service' } };
    const rpc = jest.fn(async (name, args) => {
      if (name === 'ui_upsert_mapping_artifact_v1') {
        expect(args.p_artifact.request_config).toEqual(config);
        return allowed ? { data: { primary_resource_type: 'operation_template' }, error: null }
          : { data: null, error: { message: 'Inline credentials are not allowed in executable configuration; use an auth binding' } };
      }
      if (name === 'integration_plugin_redact_projection_v1') return { data: args.p_value, error: null };
      if (name === 'integration_plugin_validate_config_v1') return { data: true, error: null };
      if (name === 'ui_me_v1') return { data: { org: { id: tenant } }, error: null };
      if (name === 'ui_settings_preview_v1') return { data: { value: policy }, error: null };
      if (name === 'ui_create_mapping_operation_report_v1') return { data: args.p_report, error: null };
      return { data: null, error: null };
    });
    const { handler } = await studio(rpc);
    const response = await handler(request('save', { source_type: 'manual', plugin_kind: 'api', artifact: 'api_outbound',
      inbound_config: { route: { method: 'POST', path_template: '/sg40', body_sample: {} } }, request_config: config, save_mode: 'direct' }));
    expect(response.status).toBe(allowed ? 200 : 400);
    const body = await response.json();
    if (allowed) expect(body.report.status).toBe('succeeded');
    else expect(body.error.message).toBe('Inline credentials are not allowed in executable configuration; use an auth binding');
    expect(JSON.stringify(body)).not.toContain('sg40-raw');
    expect(rpc.mock.calls.filter(([name]) => name === 'ui_upsert_mapping_artifact_v1')).toHaveLength(1);
    expect(rpc.mock.calls.filter(([name]) => name === 'integration_plugin_redact_projection_v1')).toHaveLength(1);
  });
  test.each(['parse','infer','preview'])('%s projects the final envelope once after internal inference', async (endpoint) => {
    const rpc = client((payload) => ({ data: { ok: payload.ok, endpoint: payload.endpoint, projected: true, correlation_id: payload.correlation_id }, error: null }));
    const { handler } = await studio(rpc);
    const response = await handler(request(endpoint, { ...base, ...(endpoint === 'preview' ? { artifact: 'api_outbound' } : {}) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, endpoint, projected: true, correlation_id: 'synthetic-correlation' });
    const calls = rpc.mock.calls.filter(([name]) => name === 'integration_plugin_redact_projection_v1');
    expect(calls).toHaveLength(1);
    expect(calls[0][1].p_value.normalized_contract.route.body_sample.token).toBe('synthetic-raw');
    expect(response.headers.get('x-correlation-id')).toBe('synthetic-correlation');
  });
  test('blocked save preserves status and projects review/report/error together', async () => {
    const rpc = client((payload) => ({ data: { ...payload, review: { projected: true }, report: { projected: true } }, error: null }));
    const { handler } = await studio(rpc);
    const response = await handler(request('save', { artifact: 'tabular_import', target_schema: { required: ['missing'] }, mapping_config: { fields: [] } }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.review).toEqual({ projected: true });
    expect(body.report).toEqual({ projected: true });
    expect(body.error.code).toBe('mapping_studio.review.blocked');
  });
  test('catch projects the error envelope and never logs the raw error text', async () => {
    const rpc = client((payload) => ({ data: { ...payload, error: { ...payload.error, message: 'projected-error' } }, error: null }));
    const { handler, log } = await studio(rpc);
    const response = await handler(request('parse', { source_type: 'token=synthetic-raw' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('projected-error');
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-raw');
  });
  test('failed projection returns a constant safe envelope without raw fallback', async () => {
    const { handler } = await studio(client(() => ({ data: { token: 'synthetic-raw' }, error: { message: 'synthetic-secret-error' } })));
    const response = await handler(request('parse', base));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('edge.integration_plugin_studio.redaction_failed');
    expect(body.error.message).toBe('Studio response projection failed');
    expect(JSON.stringify(body)).not.toMatch(/synthetic-raw|synthetic-secret-error/);
  });
  test('invalid JWT keeps its existing status/code without depending on another authenticated RPC', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'Invalid JWT synthetic-secret-error' } });
    const { handler } = await studio(rpc);
    const response = await handler(request('preview', base));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: 'edge.auth.invalid_token', message: 'Invalid authentication token' });
    expect(rpc.mock.calls.some(([name]) => name === 'integration_plugin_redact_projection_v1')).toBe(false);
  });
  test('an unavailable authenticated projection does not turn a denied parse into a server error', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'Invalid JWT synthetic-secret-error' } });
    const { handler } = await studio(rpc);
    const response = await handler(request('parse', base));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatchObject({ code: 'edge.integration_plugin_studio.failed', message: 'Capability denied' });
    expect(JSON.stringify(body)).not.toContain('synthetic-secret-error');
  });
});


test.each([
  ['test_status', 200, './studio-test-readback.mjs', 'readStudioTest', { token: 'synthetic-raw' }],
  ['test_request', 202, './studio-test-submit.mjs', 'submitStudioTest', { pending: true, token: 'synthetic-raw' }],
])('%s applies the final response projection to runtime helper results', async (endpoint, status, moduleName, exportName, result) => {
  const rpc = client(payload => ({ data: { ok: true, endpoint, projected: true }, error: null }));
  const { handler } = await studio(rpc, { [moduleName]: { [exportName]: async () => result } });
  const response = await handler(request(endpoint, {}));
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ ok: true, endpoint, projected: true });
  const projections = rpc.mock.calls.filter(([name]) => name === 'integration_plugin_redact_projection_v1');
  expect(projections).toHaveLength(1);
  expect(projections[0][1].p_value.token).toBe('synthetic-raw');
});
