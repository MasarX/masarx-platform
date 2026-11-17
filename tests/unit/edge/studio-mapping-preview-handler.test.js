const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
let previewRuntimeMapping, submitStudioTest, responseProjection, egress;
beforeAll(async () => ({ submitStudioTest } = await import('../../../supabase/functions/integration-plugin-studio/studio-test-submit.mjs')));
beforeAll(async () => ({ previewRuntimeMapping } = await import('../../../supabase/functions/integration-plugin-studio/studio-mapping-preview.mjs')));
beforeAll(async () => {
  responseProjection = await import('../../../supabase/functions/integration-plugin-studio/studio-response.mjs');
  egress = await import('../../../supabase/functions/api-caller/egress.mjs');
});
const source = fs.readFileSync(path.resolve(__dirname, '../../../supabase/functions/integration-plugin-studio/index.ts'), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const organization = '00000000-0000-4000-8000-000000000001';
const pluginVersion = '00000000-0000-4000-8000-000000000002';
// These values cross JSON HTTP/RPC boundaries, not JavaScript prototype boundaries.
// Decode both in this test realm; retain strict scalar types and array ordering.
const assertJsonEqual = (actual, expected) => assert.deepEqual(
  JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)),
);

function fixture({ allowed = ['mappings.read', 'mappings.write'], output = {}, rpcError = false, key = 'sb_secret_private', authenticated = true, expectedScope = organization, functionsUrl = 'https://database.example.test/functions/v1' } = {}) {
  const calls = [];
  let handler;
  const userClient = { auth: { getUser: async bearer => {
    calls.push({ lane: 'auth', bearer });
    return authenticated ? { data: { user: { id: organization } } } : { error: { message: 'PRIVATE AUTH DETAIL' } };
  } }, rpc: async (name, args) => {
    calls.push({ lane: 'actor', name, args });
    if (name === 'assert_capability_v1') {
      assert.equal(args.p_scope_type, expectedScope ? 'tenant' : null);
      assert.equal(args.p_scope_id, expectedScope);
      return allowed.includes(args.p_capability_key) ? {} : { error: { message: 'Capability denied' } };
    }
    if (name === 'integration_plugin_validate_v1') return { data: { validated: true } };
    if (name === 'integration_plugin_validate_config_v1') return { data: true };
    if (name === 'integration_plugin_redact_projection_v1') return { data: args.p_value };
    if (name === 'ui_settings_preview_v1') return { data: {} };
    if (name === 'ui_upsert_mapping_artifact_v1') return { data: { mapping_config_id: pluginVersion } };
    if (name === 'integration_plugin_generate_draft_v1') return { data: { plugin_version_id: pluginVersion } };
    if (name === 'ui_create_mapping_operation_report_v1') return { data: { id: pluginVersion } };
    throw new Error(`Unexpected actor RPC ${name}`);
  } };
  const createClient = (url, credential, options) => {
    if (credential === 'anon') {
      assert.equal(options.accessToken, undefined);
      assert.equal(options.global?.headers?.Authorization, 'Bearer actor');
      return userClient;
    }
    calls.push({ lane: 'private-client', url, credential, options });
    assert.equal(credential, key);
    assert.equal(options.db.schema, 'api');
    assert.equal(options.global?.headers?.apikey, undefined);
    return { rpc: async (name, args) => {
      calls.push({ lane: 'private', name, args });
      if (rpcError) return { error: { message: 'PRIVATE DATABASE DETAIL' } };
      return { data: output };
    } };
  };
  const shared = {
    readEnv: (name) => name === 'EDGE_SUPABASE_URL' ? 'https://database.example.test' : name === 'EDGE_FUNCTIONS_URL' ? functionsUrl : name === 'EDGE_SUPABASE_ANON_KEY' ? 'anon' : name === 'EDGE_SUPABASE_SECRET_KEY' ? key : '',
    extractToken: req => req.headers.get('authorization')?.replace(/^Bearer /, ''),
    parseRequestBody: async req => ({ json: await req.json() }),
    resolveCorrelationId: () => 'test-correlation',
    resolveTraceContext: () => ({}),
    logStructured: () => {},
    buildErrorEnvelope: ({ code, message }) => ({ ok: false, error: { code, message } }),
  };
  vm.runInNewContext(javascript, {
    exports: {}, Error, URL, Request, Response, Headers, console,
    Deno: { serve: fn => { handler = fn; } },
    require: name => {
      if (name.startsWith('npm:@supabase/')) return { createClient };
      if (name === './_shared/mod.mjs') return shared;
      if (name === './studio-mapping-preview.mjs') return { previewRuntimeMapping };
      if (name === './studio-test-submit.mjs') return { submitStudioTest: input => submitStudioTest({ ...input, fetchImpl: async (url, options) => {
        calls.push({ lane: 'fetch', url: String(url), options });
        return { ok: true, status: 202, body: { cancel: async () => {} } };
      } }) };
      if (name === './studio-test-readback.mjs') return {};
      if (name === './studio-response.mjs') return responseProjection;
      if (name === '../api-caller/egress.mjs') return egress;
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const body = {
    artifact: 'webhook_inbound', organization_id: organization,
    normalized_contract: { source_type: 'json', plugin_kind: 'webhook', webhook: { sample_payload: { alternate: '12' } } },
    mapping_config: { field_mappings: { amount: ['$.missing', '$.alternate'] } },
  };
  return { calls, body, request: async (endpoint = 'preview', overrides = {}, exactBody = false) => {
    const response = await handler(new Request(`https://edge.example.test/integration-plugin-studio/${endpoint}`, {
      method: 'POST', headers: { authorization: 'Bearer actor', 'content-type': 'application/json' }, body: JSON.stringify(exactBody ? overrides : { ...body, ...overrides }),
    }));
    return { status: response.status, json: await response.json() };
  } };
}

test('unauthorized preview and save never create or invoke the private evaluator, including catch', async () => {
  for (const endpoint of ['preview', 'save']) {
    const f = fixture({ allowed: [] });
    assert.equal((await f.request(endpoint)).status, 403);
    assert.equal(f.calls.filter(call => call.lane.startsWith('private')).length, 0);
    assert.equal(f.calls.filter(call => call.name === 'ui_create_mapping_operation_report_v1').length, 0);
  }
});
test('runtime preview preserves false, zero, null and nested transforms; integer schema accepts zero', async () => {
  const output = { count: 0, enabled: false, nested: { recipient: 'A' }, empty: null };
  const f = fixture({ output });
  const config = { transforms: { count: '$.count', enabled: '$.enabled', nested: { recipient: '$.name' } } };
  const result = await f.request('preview', { mapping_config: config, target_schema: { type: 'object', properties: { count: { type: 'integer' }, enabled: { type: 'boolean' } } } });
  assert.equal(result.status, 200);
  assertJsonEqual(result.json.review.coerced_preview, output);
  assertJsonEqual(result.json.review.mapping_config, config);
  assert.equal(result.json.review.preview_mode, 'runtime');
  assert.equal(result.json.review.review_summary.blocking_count, 0);
  const privateIndex = f.calls.findIndex(call => call.lane === 'private');
  assert(f.calls.slice(0, privateIndex).some(call => call.name === 'assert_capability_v1' && call.args.p_capability_key === 'mappings.read'));
});
test('workflow binding accepts canonical PostgreSQL UUIDs and rejects malformed ids', async () => {
  const workflow_template_id = '77770000-0000-0000-0000-000000770002';
  const accepted = await fixture().request('preview', { workflow_binding: { mode: 'attach_existing', workflow_template_id } });
  assert.equal(accepted.json.review.review_summary.blocking_count, 0);
  assert(!accepted.json.review.diagnostics.some(item => item.code === 'workflow_template_id_required'));

  const malformed = await fixture().request('preview', { workflow_binding: { mode: 'attach_existing', workflow_template_id: `${workflow_template_id.slice(0, -1)}z` } });
  assert.equal(malformed.json.review.review_summary.blocking_count, 1);
  assert(malformed.json.review.diagnostics.some(item => item.code === 'workflow_template_id_required' && item.blocking));
});
test('runtime schema coercion is a proposal only and cannot silently turn a string into a runtime number', async () => {
  const f = fixture({ output: { amount: '12' } });
  const result = await f.request('save', { target_schema: { type: 'object', properties: { amount: { type: 'number' } } } });
  assert.equal(result.status, 400);
  assert.equal(result.json.review.coerced_preview.amount, '12');
  assert.equal(result.json.review.coercions[0].converted_value, 12);
  assert(result.json.review.diagnostics.some(item => item.code === 'schema_type_mismatch' && item.blocking));
  assert.equal(f.calls.filter(call => call.name === 'ui_upsert_mapping_artifact_v1').length, 0);
});
test('failed canonical RPC fails closed once; catch never retries or guesses a preview', async () => {
  const f = fixture({ rpcError: true });
  const result = await f.request();
  assert.equal(result.status, 503);
  assert.equal(result.json.error.code, 'studio.preview.unavailable');
  assert(!JSON.stringify(result.json).includes('PRIVATE DATABASE DETAIL'));
  assert.equal(f.calls.filter(call => call.lane === 'private').length, 1);
});
test('both direct and draft save persist exactly the reviewed ordered fallback config', async () => {
  for (const save_mode of ['direct', 'draft']) {
    const f = fixture({ allowed: ['mappings.write', 'integration_plugins.write'], output: { amount: '12' } });
    const result = await f.request('save', { save_mode });
    assert.equal(result.status, 200);
    const saved = f.calls.find(call => call.name === (save_mode === 'direct' ? 'ui_upsert_mapping_artifact_v1' : 'integration_plugin_generate_draft_v1'));
    assertJsonEqual(saved.args.p_artifact?.mapping_config ?? saved.args.p_mapping_config, result.json.review.mapping_config);
    assertJsonEqual(result.json.review.mapping_config, f.body.mapping_config);
  }
});
test('draft fields and tabular previews remain explicitly non-runtime and never invoke SQL evaluator', async () => {
  for (const artifact of ['webhook_inbound', 'tabular_import']) {
    const f = fixture();
    const result = await f.request('preview', { artifact, mapping_config: { fields: [{ target_field: 'amount', source_path: '$.alternate' }] }, source_payload: { columns: ['alternate'], sample_rows: [{ alternate: '12' }] } });
    assert.equal(result.status, 200);
    assert.equal(result.json.review.preview_mode, artifact === 'tabular_import' ? 'tabular_proposal' : 'draft_proposal');
    assert.equal(f.calls.filter(call => call.lane === 'private').length, 0);
  }
});
test('service clients retain SDK credential handling for both JWT and secret keys', async () => {
  for (const key of ['header.payload.signature', 'sb_secret_private']) {
    const f = fixture({ key });
    assert.equal((await f.request()).status, 200);
    assert.equal(f.calls.find(call => call.lane === 'private-client').credential, key);
  }
});

test.each(['header.payload.signature', 'sb_secret_private'])('test_request retains SDK key-plane handling for %s', async key => {
  const f = fixture({ key, output: { source_id: pluginVersion, headers: { 'x-webhook-token': 'PRIVATE TOKEN' } } });
  const payload = { event: { id: organization, type: 'shipment.created' } };
  const result = await f.request('test_request', { source_id: pluginVersion, actor_id: 'forged', payload });
  assert.equal(result.status, 202);
  const client = f.calls.find(call => call.lane === 'private-client');
  assert.equal(client.credential, key);
  assert.equal(client.options.global?.headers?.apikey, undefined);
  assert.equal(client.options.db.schema, 'api');
  const material = f.calls.find(call => call.lane === 'private');
  assert.equal(material.name, 'integration_studio_test_material_v1');
  assertJsonEqual(material.args, { p_actor_id: organization, p_source_id: pluginVersion, p_raw_body: JSON.stringify(payload) });
  const dispatches = f.calls.filter(call => call.lane === 'fetch');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].url, 'https://database.example.test/functions/v1/webhook-receiver');
  assert.equal(dispatches[0].options.body, JSON.stringify(payload));
  assert.equal(result.json.pending, true);
  assert(!JSON.stringify(result.json).includes('PRIVATE TOKEN'));
});
test('test_request uses the injected internal Functions base for exactly one intake dispatch', async () => {
  const f = fixture({ functionsUrl: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:54321/functions/v1',
    output: { source_id: pluginVersion, headers: { 'x-webhook-token': 'PRIVATE TOKEN' } } });
  const payload = { event: { id: organization, type: 'shipment.created' } };
  const result = await f.request('test_request', { source_id: pluginVersion, payload });
  const dispatches = f.calls.filter(call => call.lane === 'fetch');
  assert.equal(f.calls.find(call => call.lane === 'private-client').url, 'https://database.example.test');
  assert.equal(result.status, 202);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].url, 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:54321/functions/v1/webhook-receiver');
  assert.equal(dispatches[0].options.body, JSON.stringify(payload));
});
test('test_request falls back to the hosted database Functions base', async () => {
  const f = fixture({ functionsUrl: '',
    output: { source_id: pluginVersion, headers: { 'x-webhook-token': 'PRIVATE TOKEN' } } });
  const payload = { event: { id: organization, type: 'shipment.created' } };
  const result = await f.request('test_request', { source_id: pluginVersion, payload });
  const dispatches = f.calls.filter(call => call.lane === 'fetch');
  assert.equal(result.status, 202);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].url, 'https://database.example.test/functions/v1/webhook-receiver');
});
test.each(['authentication', 'material'])('test_request %s denial never dispatches or leaks private errors', async denial => {
  const f = fixture({ authenticated: denial !== 'authentication', rpcError: denial === 'material' });
  const result = await f.request('test_request', { source_id: pluginVersion, payload: { event: { id: organization } } });
  assert.equal(result.status, 400);
  assert.equal(result.json.error.code, denial === 'authentication' ? 'studio.test.authentication_required' : 'studio.test.source_unavailable');
  assert.equal(f.calls.filter(call => call.lane === 'fetch').length, 0);
  assert.equal(f.calls.filter(call => call.lane === 'private').length, denial === 'authentication' ? 0 : 1);
  assert(!JSON.stringify(result.json).includes('PRIVATE'));
});

test.each(['parse', 'infer'])('profile7 writer %s accepts empty input without creating a draft', async endpoint => {
  const f = fixture({ allowed: ['integration_plugins.read', 'integration_plugins.write'], expectedScope: null });
  const result = await f.request(endpoint, {}, true);
  assert.equal(result.status, 200);
  assert.equal(result.json.endpoint, endpoint);
  assert.equal(result.json.draft, null);
  assert(result.json.mapping_suggestion && typeof result.json.mapping_suggestion === 'object');
  assert(f.calls.some(call => call.name === 'assert_capability_v1' && call.args.p_capability_key === 'integration_plugins.write'));
  assert.equal(f.calls.filter(call => call.name === 'integration_plugin_generate_draft_v1' || call.name === 'integration_plugin_validate_v1' || call.lane.startsWith('private') || call.lane === 'fetch').length, 0);
});
test.each(['parse', 'infer'])('profile7 reader %s is denied before producing a mapping or draft', async endpoint => {
  const f = fixture({ allowed: ['integration_plugins.read'], expectedScope: null });
  const result = await f.request(endpoint, {}, true);
  assert.equal(result.status, 403);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.mapping_suggestion, undefined);
  assert.equal(result.json.draft, undefined);
  assert(f.calls.length > 0);
  assert(f.calls.every(call => call.lane === 'actor' && ['assert_capability_v1', 'integration_plugin_redact_projection_v1'].includes(call.name)));
  assert.equal(f.calls.filter(call => call.name === 'integration_plugin_redact_projection_v1').length, 1);
  assert.equal(f.calls.at(-1).name, 'integration_plugin_redact_projection_v1');
});
test.each([
  ['writer', ['integration_plugins.read', 'integration_plugins.write'], 403],
  ['tester', ['integration_plugins.read', 'integration_plugins.test'], 200],
])('profile7 plugin-version preview enforces the %s role independently of mapping preview', async (role, allowed, status) => {
  const f = fixture({ allowed, expectedScope: null });
  const result = await f.request('preview', { plugin_version_id: pluginVersion }, true);
  assert.equal(result.status, status);
  const validations = f.calls.filter(call => call.name === 'integration_plugin_validate_v1');
  assert.equal(validations.length, role === 'tester' ? 1 : 0);
  assert.equal(f.calls.filter(call => call.lane.startsWith('private') || call.lane === 'fetch' || call.name === 'integration_plugin_generate_draft_v1').length, 0);
  assert.equal(f.calls[0].name, 'assert_capability_v1');
  assert.equal(f.calls[0].args.p_capability_key, 'integration_plugins.test');
  if (role === 'tester') {
    assertJsonEqual(validations[0].args, { p_plugin_version_id: pluginVersion, p_preview_payload: {}, p_allow_external_side_effects: false });
    assertJsonEqual(result.json.validation, { validated: true });
  } else {
    assert.equal(result.json.error.code, 'edge.integration_plugin_studio.capability_denied');
  }
});
