const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../../../supabase/functions/integration-plugin-studio/index.ts');
const source = fs.readFileSync(filename, 'utf8');
const javascript = ts.transpileModule(`${source}\nmodule.exports = {
  normalizeContract, buildDeterministicMapping, buildInboundConfigFromContract,
  buildOutboundSuggestions, buildStudioReview,
  collectSecretDiagnostics,
};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const tenant = '00000000-0000-4000-8000-000000000001';
const policy = { domain_allowlist: ['*.provider.test'], domain_denylist: ['blocked.provider.test'],
  header_allowlist: ['content-type', 'authorization'] };
const contract = { source_type: 'manual', plugin_kind: 'api', route: { method: 'POST', path_template: '/events' } };
let egress;
let responseProjection;
beforeAll(async () => {
  egress = await import('../../../supabase/functions/api-caller/egress.mjs');
  responseProjection = await import('../../../supabase/functions/integration-plugin-studio/studio-response.mjs');
});

function fixture({ value = policy, settingsError = null, me = { org: { id: tenant } }, meError = null,
  validationError = null, validationData = true, validationThrow = false } = {}) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'integration_plugin_validate_config_v1') {
      if (validationThrow) throw new Error('PRIVATE validation failure');
      return { data: validationData, error: validationError };
    }
    if (name === 'ui_me_v1') return { data: me, error: meError };
    if (name === 'ui_settings_preview_v1') return { data: { value, settings_resolution_id: 'resolution-1' }, error: settingsError };
    if (name === 'assert_capability_v1') return {};
    if (name === 'integration_plugin_generate_draft_v1') return { data: { plugin_version_id: tenant } };
    if (name === 'ui_upsert_mapping_artifact_v1') return { data: { mapping_config_id: tenant } };
    if (name === 'ui_create_mapping_operation_report_v1') return { data: { id: tenant } };
    if (name === 'integration_plugin_redact_projection_v1') return { data: args.p_value };
    throw new Error(`Unexpected actor RPC: ${name}`);
  };
  let handler;
  const edgeModule = { exports: {} };
  const shared = {
    readEnv: (name) => name === 'EDGE_SUPABASE_URL' ? 'https://database.example.test'
      : name === 'EDGE_SUPABASE_ANON_KEY' ? 'anon' : '',
    extractToken: () => 'actor', parseRequestBody: async (req) => ({ json: await req.json() }),
    resolveCorrelationId: () => 'test-correlation', resolveTraceContext: () => ({}), logStructured: () => {},
    buildErrorEnvelope: ({ code, message, details }) => ({ ok: false, error: { code, message, details } }),
  };
  vm.runInNewContext(javascript, {
    module: edgeModule, exports: edgeModule.exports, Error, URL, Request, Response, Headers, console,
    Deno: { serve: (fn) => { handler = fn; } },
    require: (name) => {
      if (name.startsWith('npm:@supabase/')) return { createClient: () => ({ rpc }) };
      if (name === './_shared/mod.mjs') return shared;
      if (name === '../api-caller/egress.mjs') return egress;
      if (name === './studio-response.mjs') return responseProjection;
      // The carrier's separate runtime-preview/test helpers are not invoked by these authoring cases.
      if (name.startsWith('./studio-')) return {};
      throw new Error(`Unexpected edge import: ${name}`);
    },
  }, { filename });
  return { ...edgeModule.exports, calls,
    review: (body = {}, artifact = 'api_outbound', organizationId = tenant, normalized = contract) =>
      edgeModule.exports.buildStudioReview({ rpc }, { request_config: { url_template: 'https://api.provider.test/events' },
        ...body }, artifact, organizationId, normalized, { fields: [] }),
    request: async (endpoint, body) => {
      const response = await handler(new Request(`https://edge.example.test/integration-plugin-studio/${endpoint}`, {
        method: 'POST', headers: { authorization: 'Bearer actor', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      return { status: response.status, json: await response.json() };
    },
  };
}
const codes = (review) => review.diagnostics.map((entry) => entry.code);

test('omitted organization resolves the authenticated canonical tenant through existing settings APIs', async () => {
  const f = fixture();
  expect(codes(await f.review({}, 'api_outbound', null))).toEqual([]);
  expect(f.calls.filter(({ name }) => name !== 'integration_plugin_validate_config_v1')).toEqual([
    { name: 'ui_me_v1', args: undefined },
    { name: 'ui_settings_preview_v1', args: { p_category: 'integration_plugin_egress_policy',
      p_scope_type: 'tenant', p_scope_id: tenant } },
  ]);
  expect(f.calls.filter(({ name }) => name === 'integration_plugin_validate_config_v1')).toHaveLength(1);
});
test('explicit organization retains exact tenant authorization and policy provenance', async () => {
  const f = fixture();
  const result = await f.review({ request_config: { url_template: 'https://blocked.provider.test' } });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1].name).toBe('integration_plugin_validate_config_v1');
  expect(f.calls[0].args.p_scope_id).toBe(tenant);
  expect(result.diagnostics[0]).toMatchObject({ code: 'egress_domain_denied',
    source_policy: 'integration_plugin_egress_policy', settings_resolution_id: 'resolution-1' });
});
test.each([
  { value: null }, { value: [] }, { value: { ...policy, domain_denylist: 'bad' } },
  { value: { ...policy, header_allowlist: [7] } }, { value: { ...policy, domain_allowlist: [''] } },
  { value: { ...policy, header_allowlist: null } },
  { settingsError: { message: 'PRIVATE DB DETAIL' } }, { me: {} }, { meError: { message: 'PRIVATE DB DETAIL' } },
])('missing/malformed/denied policy stays unavailable, not an unrestricted success: %j', async (options) => {
  const result = await fixture(options).review({}, 'api_outbound', null);
  expect(codes(result)).toContain('egress_policy_unavailable');
  expect(JSON.stringify(result)).not.toContain('PRIVATE DB DETAIL');
});
test.each([
  ['https://api.provider.test', true], ['https://nested.api.provider.test', true],
  ['https://provider.test', false], ['https://evilprovider.test', false],
  ['https://api.provider.test.attacker.test', false],
])('wildcard allowlist has the runtime boundary: %s', async (url, allowed) => {
  const result = await fixture().review({ request_config: { url_template: url } });
  expect(codes(result).includes('egress_domain_not_allowlisted')).toBe(!allowed);
});
test.each(['blocked.provider.test', 'child.blocked.provider.test'])('deny beats allow for %s', async (host) => {
  const result = await fixture().review({ request_config: { url_template: `https://${host}` } });
  expect(codes(result)).toContain('egress_domain_denied');
});
test('exact allowlist does not admit subdomains and wildcard deny includes its root', async () => {
  const f = fixture({ value: { ...policy, domain_allowlist: ['api.provider.test'], domain_denylist: ['*.blocked.test'] } });
  expect(codes(await f.review({ request_config: { url_template: 'https://child.api.provider.test' } })))
    .toContain('egress_domain_not_allowlisted');
  expect(codes(await f.review({ request_config: { url_template: 'https://blocked.test' } })))
    .toContain('egress_domain_denied');
});
test.each(['localhost', 'app.localhost', 'host.local', '127.1', '192.0.2.10', '172.31.0.1',
  '192.168.0.1', '192.0.2.10', '0.0.0.0', '[::1]', '[fc00::1]', '[::ffff:127.0.0.1]'])
('authoring rejects literal local/non-public host %s without doing DNS or network I/O', async (host) => {
  const f = fixture({ value: { ...policy, domain_allowlist: ['*'] } });
  expect(codes(await f.review({ request_config: { url_template: `https://${host}` } })))
    .toContain('egress_private_network_blocked');
});
test.each([
  ['http://api.provider.test', 'egress_requires_https'], ['not a URL', 'egress_invalid_url'],
  [(['https',":","/","/",'user',":",'password',"@",'api.provider.test'].join("")), 'egress_invalid_url'], ['', 'egress_url_required'],
])('invalid target %s is a blocking diagnostic', async (url, expected) => {
  const result = await fixture().review({ request_config: { url_template: url } });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: expected, blocking: true,
    fieldPath: 'request_config.url_template' }));
});
test('all plugin operation rows are reviewed without dropping invalid rows or changing diagnostic indices', async () => {
  const result = await fixture().review({ outbound_operations: [
    { url_template: 'https://api.provider.test', headers_template: { 'Content-Type': 'application/json' } },
    { url_template: 'https://blocked.provider.test' },
    { url_template: 'https://api.provider.test', headers_template: { 'X-Internal': 'not-a-secret' } }, null,
  ] }, 'integration_plugin');
  expect(result.diagnostics.map(({ code, fieldPath }) => ({ code, fieldPath }))).toEqual([
    { code: 'egress_domain_denied', fieldPath: 'outbound_operations[1].url_template' },
    { code: 'header_not_allowlisted', fieldPath: 'outbound_operations[2].headers_template.X-Internal' },
    { code: 'egress_url_required', fieldPath: 'outbound_operations[3].url_template' },
  ]);
});
test('webhook plugins also review explicitly configured outbound operations', async () => {
  const result = await fixture().review({ outbound_operations: [{ url_template: 'http://api.provider.test' }] },
    'integration_plugin', tenant, { ...contract, plugin_kind: 'webhook' });
  expect(codes(result)).toContain('egress_requires_https');
});
test('empty API operations are blocked and empty header allowlist is deny-all', async () => {
  expect(codes(await fixture().review({ outbound_operations: [] }, 'integration_plugin')))
    .toContain('outbound_operation_required');
  const f = fixture({ value: { ...policy, header_allowlist: [] } });
  expect(codes(await f.review({ request_config: { url_template: 'https://api.provider.test',
    headers_template: { Authorization: '{{credential}}' } } }))).toContain('header_not_allowlisted');
});
test('legacy headers_allowlist remains compatible', async () => {
  const { header_allowlist, ...other } = policy;
  expect(codes(await fixture({ value: { ...other, headers_allowlist: header_allowlist } }).review({
    request_config: { url_template: 'https://api.provider.test', headers_template: { 'CONTENT-TYPE': 'application/json' } },
  }))).toEqual([]);
});
test('schema-valid partial legacy policy keeps the runtime header defaults and private-target prohibition', async () => {
  const f = fixture({ value: {} });
  expect(codes(await f.review({ request_config: { url_template: 'https://api.provider.test',
    headers_template: { 'Content-Type': 'application/json' } } }))).toEqual([]);
  expect(codes(await f.review({ request_config: { url_template: 'https://localhost',
    headers_template: { 'X-Internal': 'not-a-secret' } } })))
    .toEqual(['egress_private_network_blocked', 'header_not_allowlisted']);
});
test.each(['api_outbound', 'integration_plugin'])('preview and save share blocking review for %s', async (artifact) => {
  const f = fixture();
  const body = { artifact, organization_id: tenant, normalized_contract: contract, mapping_config: { fields: [] },
    request_config: { url_template: 'https://blocked.provider.test' },
    outbound_operations: [{ url_template: 'https://blocked.provider.test' }] };
  const preview = await f.request('preview', body);
  const save = await f.request('save', body);
  expect(preview.status).toBe(200);
  expect(save.status).toBe(400);
  expect(save.json.error.code).toBe('mapping_studio.review.blocked');
  expect(save.json.review.diagnostics).toEqual(preview.json.review.diagnostics);
  expect(f.calls.some(({ name }) => ['ui_upsert_mapping_artifact_v1', 'integration_plugin_generate_draft_v1'].includes(name)))
    .toBe(false);
});
test.each(['parse', 'infer'])('legacy %s cannot persist an unreviewed outbound draft', async (endpoint) => {
  const f = fixture();
  const result = await f.request(endpoint, { source_type: 'manual', persist_draft: true,
    inbound_config: { route: { method: 'POST', path_template: '/events' } },
    outbound_operations: [{ url_template: 'https://blocked.provider.test' }] });
  expect(result.status).toBe(400);
  expect(result.json.error.code).toBe('mapping_studio.review.blocked');
  expect(f.calls.some(({ name }) => name === 'integration_plugin_generate_draft_v1')).toBe(false);
});
test('valid draft save retains caller mappings, operation configuration and credential references', async () => {
  const f = fixture();
  const mapping = { fields: [{ target_field: 'external_id', source_path: '$.reference' }],
    metadata: { configured_by: 'caller' } };
  const operations = [{ operation_name: 'provider_create', url_template: 'https://api.provider.test/orders',
    headers_template: { Authorization: '{{credential}}' }, auth: { credential_binding_id: tenant } }];
  const result = await f.request('save', { artifact: 'integration_plugin', organization_id: tenant,
    normalized_contract: contract, mapping_config: mapping, outbound_operations: operations });
  expect(result.status).toBe(200);
  const saved = f.calls.find(({ name }) => name === 'integration_plugin_generate_draft_v1').args;
  expect(saved.p_mapping_config).toEqual(mapping);
  expect(saved.p_outbound_operations).toEqual(operations);
  expect(f.calls.filter(({ name }) => name === 'ui_settings_preview_v1')).toHaveLength(1);
});

describe('Studio mapping normalization', () => {
  const document = { openapi: '3.0.3', servers: [{ url: 'https://api.provider.test/v1?ignored=1' }],
    paths: { '/shipments': { post: {} } } };
  test.each([document, { openapi: document }, JSON.stringify(document)])('accepts direct/scalar-version/wrapped OpenAPI %j', (payload) => {
    const f = fixture();
    const normalized = f.normalizeContract({ source_type: 'openapi', source_payload: payload });
    expect(normalized.route.path_template).toBe('/shipments');
    expect(f.buildInboundConfigFromContract(normalized).route.upstream_base_url).toBe('https://api.provider.test');
    expect(f.buildOutboundSuggestions(normalized)[0].url_template).toBe('https://api.provider.test/shipments');
  });
  test.each([{}, { openapi: '3.0.3' }, { openapi: { paths: {} } }, 7])('rejects invalid OpenAPI %j', (payload) => {
    expect(() => fixture().normalizeContract({ source_type: 'openapi', source_payload: payload })).toThrow();
  });
  test('provider URL uses origin, preserves operation path/query, and falls back from invalid source to server', () => {
    const f = fixture();
    const normalized = { ...contract, route: { ...contract.route, upstream_path_template: 'v2/events?expand=1' },
      metadata: { source_url: 'bad URL', server_url: 'https://api.provider.test/old?not-carried=1#fragment' } };
    expect(f.buildOutboundSuggestions(normalized)[0].url_template).toBe('https://api.provider.test/v2/events?expand=1');
    expect(f.buildInboundConfigFromContract(normalized).route.upstream_base_url).toBe('https://api.provider.test');
    normalized.metadata = { source_url: 'https://source.provider.test/base', server_url: 'https://alternate.provider.test' };
    expect(f.buildOutboundSuggestions(normalized)[0].url_template).toBe('https://source.provider.test/v2/events?expand=1');
    normalized.metadata = { source_url: (['https',":","/","/",'user',":",'password',"@",'api.provider.test'].join("")), server_url: 'file:///tmp/local' };
    expect(f.buildOutboundSuggestions(normalized)[0].url_template).toBe('https://example-provider.invalid/v2/events?expand=1');
  });
  test('cURL separates provider origin from path and query without replacing caller mappings', () => {
    const f = fixture();
    const normalized = f.normalizeContract({ source_type: 'curl', source_payload: {
      curl: 'curl -X POST https://api.provider.test/shipments?mode=fast -d \'{"reference":"REF-1"}\'',
    } });
    expect(normalized.metadata).toMatchObject({ source_url: 'https://api.provider.test', query_string: 'mode=fast' });
    expect(f.buildOutboundSuggestions(normalized)[0].url_template).toBe('https://api.provider.test/shipments');
  });
  test('webhook inference carries shipment/recipient/address targets, later candidates and metadata', () => {
    const f = fixture();
    const mapping = f.buildDeterministicMapping(f.normalizeContract({ source_type: 'webhook_sample', source_payload: {
      payload: { awb: 'TRACK-1', reference: 'REF-1', customer: { name: 'Synthetic recipient', phone: '0000' },
        destination: { city: 'Riyadh', line1: 'Synthetic address', country: 'SA' }, currency: 'SAR' },
    } }));
    expect(mapping).toMatchObject({ target: 'shipments.create', enabled: true,
      metadata: { canonical_intent: 'shipment.create', mapping_profile: 'plugin_studio_webhook_shipment_create_v1' } });
    expect(mapping.fields).toContainEqual(expect.objectContaining({ target_field: 'tracking_number', source_path: '$.awb' }));
    expect(mapping.transforms.shipment.tracking_number).toEqual(['awb', 'shipment.tracking_number', 'tracking_number', 'waybill', 'barcode']);
    expect(mapping.transforms.recipient.name).toEqual(['customer.name', 'Example Entity ntvplorhukthpmnmvgrstqzp', 'recipient.name', 'customer_name']);
    expect(Object.keys(mapping.transforms.shipment)).toEqual(['tracking_number', 'external_id', 'reference_number',
      'service_type', 'service_level', 'cod_amount', 'currency']);
    expect(Object.keys(mapping.transforms.recipient)).toEqual(['external_id', 'name', 'phone', 'email']);
    expect(Object.keys(mapping.transforms.address)).toEqual(['line1', 'line2', 'district', 'city', 'province', 'country_code', 'lat', 'lng']);
    expect(mapping.transforms.address.country_code).toContain('shipment.destination.country');
  });
});


test.each(['api_token', 'x-access-token', 'secret_key', 'access_key', 'api_secret',
  'webhook_secret', 'aws_secret_access_key', 'passwd', 'apiToken', 'AccessKey', 'accessKey',
  'signingKey', 'encryptionKey', 'masterKey', 'clientKey', 'licenseKey', 'aws.access.key', 'signing key'])(
  'preview/save honor database credential rejection for %s', async (key) => {
    const f = fixture({ validationError: { code: '23514', message: 'Inline credentials are not allowed' } });
    const body = { artifact: 'api_outbound', organization_id: tenant, normalized_contract: contract,
      request_config: { url_template: 'https://api.provider.test/events', body_template: { [key]: 'synthetic-private' } } };
    const preview = await f.request('preview', body);
    expect(preview.json.review.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'secret_like_value_detected', blocking: true,
        fieldPath: 'request_config' }),
    ]));
    expect((await f.request('save', body)).status).toBe(400);
    expect(f.calls.some(({ name }) => ['integration_plugin_generate_draft_v1','ui_upsert_mapping_artifact_v1'].includes(name))).toBe(false);
    expect(f.calls.find(({ name }) => name === 'integration_plugin_validate_config_v1').args.p_value.request_config.body_template[key])
      .toBe('synthetic-private');
    expect(JSON.stringify(preview.json)).not.toContain('synthetic-private');
  },
);
test('credential references and deliberate public identifiers remain authorable', async () => {
  const result = await fixture().review({ request_config: { url_template: 'https://api.provider.test/events',
    body_template: { api_token: '{{provider.token}}', secret_key: { type: 'SecretRef', id: tenant },
      public_token: 'public-reference', plugin_key: 'plugin-name', mapping_key: 'mapping-name', handler_key: 'outbound_http' } } });
  expect(codes(result)).not.toContain('secret_like_value_detected');
});
test('an empty tenant allowlist cannot approve a templated provider host', async () => {
  const result = await fixture({ value: { ...policy, domain_allowlist: [] } })
    .review({ request_config: { url_template: 'https://{{host}}/events' } });
  expect(result.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'egress_domain_not_allowlisted', blocking: true }),
  ]));
});

test.each(['sort_key','idempotency_key','public_key','publishable_key',
  'max_tokens','token_type','credential_type','next_page_token','page_token'])(
  'non-secret authoring key %s remains usable', async key => {
    const f = fixture();
    const result = await f.request('save', { artifact: 'api_outbound', organization_id: tenant,
      normalized_contract: contract, request_config: { url_template: 'https://api.provider.test/events',
        body_template: { [key]: 'public-reference' } } });
    expect(result.status).toBe(200);
  },
);

test.each([123, true, false])('numeric/boolean credential-shaped values remain usable: %s', async value => {
  const result = await fixture().request('save', { artifact: 'api_outbound', organization_id: tenant,
    normalized_contract: contract, request_config: { url_template: 'https://api.provider.test/events',
      body_template: { apiToken: value, AccessKey: value } } });
  expect(result.status).toBe(200);
});

test.each([{ envelope: { AccessKey: 'synthetic-private' } }, { rows: [{ nested: { apiToken: 'synthetic-private' } }] }])(
  'nested credentials inside objects/arrays block save: %j', async body_template => {
    const result = await fixture({ validationError: { code: '23514' } }).request('save', { artifact: 'api_outbound', organization_id: tenant,
      normalized_contract: contract, request_config: { url_template: 'https://api.provider.test/events', body_template } });
    expect(result.status).toBe(400);
  },
);

test.each([{ validationError: { code: '42501', message: 'PRIVATE validation failure' } },
  { validationData: false }, { validationThrow: true }])(
  'preview/save fail closed when the shared credential validator is unavailable: %j', async options => {
    const f = fixture(options);
    const body = { artifact: 'api_outbound', organization_id: tenant, normalized_contract: contract,
      request_config: { url_template: 'https://api.provider.test/events' } };
    const preview = await f.request('preview', body);
    expect(codes(preview.json.review)).toContain('credential_validation_unavailable');
    expect(preview.json.review.review_summary.blocking_count).toBeGreaterThan(0);
    expect(JSON.stringify(preview.json)).not.toContain('PRIVATE');
    expect((await f.request('save', body)).status).toBe(400);
    expect(f.calls.some(({ name }) => name === 'ui_upsert_mapping_artifact_v1')).toBe(false);
  },
);

test('preview supplies the complete persisted configuration and canonical sample to the shared SQL boundary', async () => {
  const f = fixture();
  const sample = { input: { value: 'synthetic-input' } };
  const request_config = { url_template: 'https://api.provider.test/events',
    body_template: '{"apiKey":"$.input.value"}' };
  await f.review({ request_config, mapping_config: { fields: [] } }, 'api_outbound', tenant,
    { ...contract, route: { ...contract.route, body_sample: sample } });
  const validation = f.calls.find(({ name }) => name === 'integration_plugin_validate_config_v1').args;
  expect(validation.p_input).toEqual(sample);
  expect(validation.p_value).toMatchObject({ request_config, mapping_config: { fields: [] },
    response_mapping_config: {}, outbound_operations: [request_config] });
});

test.each(['key','apikeY','ACCESSKEY','masterkey','licensekey','secretkey','privatekey','clientkey','authkey',
  'passphrase','pwd','cookie','signature','hmac','primary_key','apiToken','AccessKey'])(
  'sample warnings recursively retain credential ancestry for %s', key => {
    const diagnostics = [];
    fixture().collectSecretDiagnostics({ [key]: { rows: [{ public_key: 'synthetic-private', count: 3, enabled: true }] } },
      'sample', diagnostics, {});
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'secret_like_value_detected', blocking: false,
      fieldPath: 'sample.' + key + '.rows[0].public_key' })]);
  },
);
