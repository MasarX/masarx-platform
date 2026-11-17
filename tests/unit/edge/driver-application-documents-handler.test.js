const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const { webcrypto } = require('crypto');
const ID = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const RETRY = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://landing.example.test';
const compiled = new Map();
function load(name, scenario = {}) {
  const calls = [];
  let manifest;
  let handler;
  const rpc = async (name, args) => {
    calls.push([name, args]);
    if (scenario.rpc) { const result = await scenario.rpc(name, args); if (result !== undefined) return result; }
    if (name === 'driver_application_document_reserve_v1') {
      manifest = args.p_documents.map((d, i) => ({ ...d, storage_bucket: 'fieldops-evidence', storage_key: 'driver-applications/request/' + ATTEMPT + '/' + i }));
      return { data: { ok: true, new_attempt: true, attempt_id: ATTEMPT, manifest } };
    }
    if (name === 'driver_application_document_apply_v1') return { data: { ok: true, status: 'pending', attempt_id: ATTEMPT, application_state: 'documents_resubmitted' } };
    if (name === 'driver_application_document_abort_v1') return { data: { ok: true, state: 'aborted', cleanup_manifest: manifest, cleanup_state: args.p_cleanup_complete ? 'complete' : 'pending' } };
    if (name === 'driver_application_document_readback_v1') return { data: { ok: true, state: 'aborted', cleanup_state: 'pending' } };
    if (name === 'marketplace_application_status_by_token_v1') return { data: { ok: true, status: 'pending', application_state: 'additional_documents_requested', requested_documents: ['license'], missing_document_count: 1 } };
    throw new Error(name);
  };
  const client = { rpc, storage: { from: bucket => ({
    upload: async (key, bytes, options) => { calls.push(['upload', { bucket, key, bytes, options }]); return scenario.upload ? scenario.upload(key, calls) : { data: { path: key } }; },
    remove: async keys => { calls.push(['remove', keys]); return scenario.remove ? scenario.remove(keys) : { data: keys }; },
  }) } };
  const env = { EDGE_SUPABASE_URL: 'https://db.example.test', EDGE_SUPABASE_SECRET_KEY: 'sb_secret_fixture', DRIVER_SIGNUP_CORS_ALLOW_ORIGINS: ORIGIN, ...scenario.env };
  const root = path.resolve('supabase/functions');
  const sandbox = vm.createContext({ Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, crypto: webcrypto, atob, btoa, setTimeout, clearTimeout,
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } } });
  const cache = new Map();
  function moduleAt(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file.replace(/\.mjs$/, '.ts'),
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
    const fn = vm.runInContext('(function(require,exports){' + compiled.get(file) + '\n})', sandbox);
    fn(spec => spec === 'npm:@supabase/supabase-js@2.111.0' ? { createClient: (_url, _key, options) => { calls.push(['client', options]); return client; } }
      : moduleAt(path.resolve(path.dirname(file), spec)), exports);
    return exports;
  }
  moduleAt(path.join(root, name, 'index.ts'));
  return { calls, send: payload => handler(new Request('https://edge.example.test/functions/v1/' + name, {
    method: 'POST', headers: { origin: scenario.origin || ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })) };
}
const payload = () => ({ token: ID, retry_key: RETRY, documents: [{ type: 'license', file_name: 'license.json', content_type: 'application/json', text: '{"reference":"owned"}' }] });
describe('driver requested-document return real Edge handlers', () => {
  test('validates all bytes before reserve, uploads immutable manifest and applies submitted result', async () => {
    const app = load('driver-application-documents'); const response = await app.send(payload());
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, application_state: 'documents_resubmitted' });
    const upload = app.calls.find(c => c[0] === 'upload')[1];
    expect(upload.options.upsert).toBe(false); expect(upload.key).not.toContain(RETRY); expect(upload.key).not.toContain(ID);
    expect(app.calls.find(c => c[0] === 'client')[1].db.schema).toBe('api');
    expect(app.calls.some(c => c[0] === 'remove')).toBe(false);
  });
  test.each([null, {}, { status: 'pending' }, { ok: true }])('status rejects malformed success %j', async result => {
    const app = load('driver-application-status', { rpc: async () => ({ data: result }) });
    expect((await app.send({ status_token: ID })).status).not.toBe(200);
  });
  test('status alias returns safe requested fields without arbitrary metadata', async () => {
    const app = load('driver-application-status', { rpc: async () => ({ data: { ok: true, status: 'rejected', application_state: 'compliance_denied',
      requested_documents: ['license'], missing_document_count: 1, secret: 'never', profile_handoff: { ready: false, secret: 'never' } } }) });
    const result = await (await app.send({ status_token: ID })).json();
    expect(result.application_state).toBe('compliance_denied'); expect(result.requested_documents).toEqual(['license']); expect(JSON.stringify(result)).not.toContain('never');
  });
  test.each(['status', 'verified_at', 'verified_by_user_id', 'storage_key'])('rejects forged %s before storage', async key => {
    const app = load('driver-application-documents'); const p = payload(); p.documents[0][key] = 'forged';
    expect((await app.send(p)).status).toBe(400); expect(app.calls.some(c => c[0] === 'upload')).toBe(false);
  });
  test('invalid later document does not leave partial earlier upload', async () => {
    const app = load('driver-application-documents'); const p = payload(); p.documents.push({ ...p.documents[0], base64: '!!!', text: '' });
    expect((await app.send(p)).status).toBe(400); expect(app.calls.some(c => c[0] === 'upload')).toBe(false);
  });
  test('same-key reserved replay grants no second uploader or abort authority', async () => {
    const app = load('driver-application-documents', { rpc: async name => name.endsWith('reserve_v1') ? { data: { ok: true, state: 'reserved', new_attempt: false, attempt_id: ATTEMPT } } : undefined });
    expect((await app.send(payload())).status).toBe(202); expect(app.calls.map(c => c[0])).not.toContain('upload');
    expect(app.calls.map(c => c[0])).not.toContain('driver_application_document_abort_v1');
  });
  test('lost apply response reads committed receipt and never compensates', async () => {
    const app = load('driver-application-documents', { rpc: async name => name.endsWith('apply_v1') ? { error: { message: 'network' } } :
      name.endsWith('readback_v1') ? { data: { ok: true, state: 'committed', result: { ok: true, status: 'pending', attempt_id: ATTEMPT, application_state: 'documents_resubmitted' } } } : undefined });
    expect((await app.send(payload())).status).toBe(200); expect(app.calls.map(c => c[0])).not.toContain('remove');
    expect(app.calls.map(c => c[0])).not.toContain('driver_application_document_abort_v1');
  });
  test('unknown upload retains abort-fenced manifest without deletion', async () => {
    const app = load('driver-application-documents', { upload: async () => { throw Error('transport'); } });
    expect((await app.send(payload())).status).toBe(409);
    expect(app.calls.map(c => c[0])).toContain('driver_application_document_abort_v1');
    expect(app.calls.map(c => c[0])).not.toContain('remove');
  });
  test('definite upload failure compensates only after abort and records cleanup acknowledgement', async () => {
    const app = load('driver-application-documents', { upload: async () => ({ error: { statusCode: 413 } }) });
    await app.send(payload()); const kinds = app.calls.map(c => c[0]);
    expect(kinds.indexOf('remove')).toBeGreaterThan(kinds.indexOf('driver_application_document_abort_v1'));
    expect(app.calls.filter(c => c[0] === 'driver_application_document_abort_v1')[1][1].p_cleanup_complete).toBe(true);
  });
  test('abort observing a concurrent committed result never removes objects', async () => {
    const app = load('driver-application-documents', { upload: async () => ({ error: { statusCode: 409 } }),
      rpc: async name => name.endsWith('abort_v1') ? { data: { ok: true, state: 'committed', result: { ok: true, status: 'pending', attempt_id: ATTEMPT, application_state: 'documents_resubmitted' } } } : undefined });
    expect((await app.send(payload())).status).toBe(200); expect(app.calls.map(c => c[0])).not.toContain('remove');
  });
  test('definite reservation absence permits client same-payload retry, not endless pending', async () => {
    const app = load('driver-application-documents', { rpc: async () => ({ data: { ok: true, state: 'not_found' } }) });
    const response = await app.send({ token: ID, retry_key: RETRY, mode: 'readback' });
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ state: 'not_found' });
  });
  test('foreign origin fails before client/storage construction', async () => {
    const app = load('driver-application-documents', { origin: 'https://evil.example.test' });
    expect((await app.send(payload())).status).toBe(403); expect(app.calls).toEqual([]);
  });
  test.each([null, {}, { ok: true }, { ok: true, status: 'pending' }])('malformed apply result %j is uncertain and never compensated', async result => {
    const app = load('driver-application-documents', { rpc: async name => name.endsWith('apply_v1') ? { data: result } :
      name.endsWith('readback_v1') ? { data: { ok: true, state: 'reserved', attempt_id: ATTEMPT } } : undefined });
    expect((await app.send(payload())).status).toBe(202);
    expect(app.calls.map(c => c[0])).not.toContain('driver_application_document_abort_v1');
    expect(app.calls.map(c => c[0])).not.toContain('remove');
  });
  test('committed retry key with different bytes returns definite conflict, not old success', async () => {
    const app = load('driver-application-documents', { rpc: async name => name.endsWith('reserve_v1') ?
      { error: { code: '23514', message: 'document_attempt_payload_changed' } } : undefined });
    const response = await app.send(payload());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'document_attempt_payload_changed' } });
    expect(app.calls.map(c => c[0])).not.toContain('driver_application_document_readback_v1');
    expect(app.calls.map(c => c[0])).not.toContain('upload');
  });
  test('explicit abandon of recovered attempt fences apply but never claims settled uploads or deletes', async () => {
    const app = load('driver-application-documents', { rpc: async name => name.endsWith('readback_v1') ?
      { data: { ok: true, state: 'reserved', attempt_id: ATTEMPT } } : undefined });
    const response = await app.send({ token: ID, retry_key: RETRY, mode: 'abandon' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ state: 'aborted', cleanup_state: 'pending' });
    expect(app.calls.find(c => c[0] === 'driver_application_document_abort_v1')[1]).toEqual({ p_status_token: ID, p_attempt_id: ATTEMPT });
    expect(app.calls.map(c => c[0])).not.toContain('remove');
    expect(app.calls.map(c => c[0])).not.toContain('upload');
  });
  test('two simultaneous same-key invocations have exactly one uploader', async () => {
    let reserveCount = 0, releaseUpload;
    const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
    const app = load('driver-application-documents', {
      rpc: async name => name.endsWith('reserve_v1') && ++reserveCount > 1 ?
        { data: { ok: true, new_attempt: false, state: 'reserved', attempt_id: ATTEMPT } } : undefined,
      upload: async key => { await uploadGate; return { data: { path: key } }; },
    });
    const first = app.send(payload());
    while (!app.calls.some(c => c[0] === 'upload')) await new Promise(resolve => setImmediate(resolve));
    try { expect((await app.send(payload())).status).toBe(202); }
    finally { releaseUpload(); }
    expect((await first).status).toBe(200);
    expect(app.calls.filter(c => c[0] === 'upload')).toHaveLength(1);
    expect(app.calls.map(c => c[0])).not.toContain('driver_application_document_abort_v1');
  });
  test('partial definite failure cleans only exact abort manifest including the prior upload', async () => {
    let uploads = 0;
    const app = load('driver-application-documents', { upload: async key => ++uploads === 1 ? { data: { path: key } } : { error: { statusCode: '413' } } });
    const p = payload(); p.documents.push({ ...p.documents[0], type: 'registration', text: '{"reference":"second"}' });
    await app.send(p);
    const keys = app.calls.filter(c => c[0] === 'upload').map(c => c[1].key);
    expect(keys).toHaveLength(2);
    expect(app.calls.find(c => c[0] === 'remove')[1]).toEqual(keys);
  });
  test('status exposes only the token-authorized retry discovery, not private attempt manifest', async () => {
    const app = load('driver-application-status', { rpc: async () => ({ data: { ok: true, status: 'pending',
      application_state: 'additional_documents_requested', document_review_revision: 2,
      document_return_attempt: { state: 'reserved', retry_key: RETRY, manifest: ['secret-object'], manifest_hash: 'secret-hash' } } }) });
    const body = await (await app.send({ token: ID })).json();
    expect(body.document_return_attempt).toEqual({ state: 'reserved', retry_key: RETRY });
    expect(body.document_review_revision).toBe(2);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  test('statement completion unknown SQLSTATE is read back and never compensated', async () => {
    const app = load('driver-application-documents', { rpc: async name => name.endsWith('apply_v1') ?
      { error: { code: '40003', message: 'statement_completion_unknown' } } :
      name.endsWith('readback_v1') ? { data: { ok: true, state: 'reserved', attempt_id: ATTEMPT } } : undefined });
    expect((await app.send(payload())).status).toBe(202);
    expect(app.calls.map(c => c[0])).not.toContain('driver_application_document_abort_v1');
    expect(app.calls.map(c => c[0])).not.toContain('remove');
  });

});
