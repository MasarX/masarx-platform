const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createEdgeDbJwt, buildSupabaseApiKeys } = require('../../../scripts/ops/workspace/edge-db-jwt');

const endpoint = new URL('/functions/v1/label-renderer', ['https://renderer', 'example', 'test'].join('.'));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const key = randomBytes(32).toString('hex');
const projectSecret = randomBytes(32);
const anonKey = buildSupabaseApiKeys({ secret: projectSecret }).anon;
const gatewayJwt = createEdgeDbJwt({ secret: projectSecret, role: 'edge_renderer_gateway_role' });
const tokenHeader = 'x-masarx-renderer-token';
const now = 2_000_000_000;
let authorize;
let verify;
let sign;

beforeAll(async () => {
  ({ authorizeLabelRendererRequest: authorize, verifyLabelRendererToken: verify } =
    await import('../../../supabase/functions/label-renderer/auth.mjs'));
  ({ authorizeRendererSend: sign } = await import('../../../supabase/functions/api-caller/renderer-auth.mjs'));
});

function request({ claims = {}, alg = 'HS256', signingKey = key } = {}) {
  const header = encode({ alg, typ: 'JWT' });
  const payload = encode({ iss: 'supabase', aud: 'authenticated', sub: 'edge-function', role: 'edge_label_renderer_role',
    iat: now, exp: now + 60, jti: randomUUID(), ...claims });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', signingKey).update(unsigned).digest('base64url');
  return new Request(endpoint, {
    method: 'POST', headers: { authorization: `Bearer ${gatewayJwt}`, [tokenHeader]: `${unsigned}.${signature}` },
  });
}

test.each(['jobs', 'print', 'bundle'])('accepts the dedicated api-caller token for %s', async (operation) => {
  const dispatch = await sign({ url: endpoint.href }, endpoint.href, key, gatewayJwt);
  const req = new Request(endpoint, { method: 'POST', headers: dispatch.headers });
  expect(req.headers.get('authorization')).toBe(`Bearer ${gatewayJwt}`);
  expect(authorize(req, operation, { requireDbJwt: true, rendererTokenOnly: true })).toMatchObject({ ok: true });
  await expect(verify(req, key)).resolves.toEqual({ ok: true });
});

test.each(['jobs', 'print', 'bundle'])('does not use the gateway bearer to authorize %s', async (operation) => {
  const signedToken = request().headers.get(tokenHeader);
  for (const bearer of [gatewayJwt, anonKey, signedToken]) {
    const req = new Request(endpoint, { headers: { authorization: `Bearer ${bearer}` } });
    expect(authorize(req, operation, { requireDbJwt: true, rendererTokenOnly: true }).ok).toBe(false);
    await expect(verify(req, key, now)).resolves.toMatchObject({ ok: false, status: 401 });
  }
});

test.each([
  ['wrong signature', { signingKey: randomBytes(32).toString('hex') }],
  ['alg none', { alg: 'none' }],
  ['any other algorithm', { alg: 'HS512' }],
  ['wrong audience', { claims: { aud: ['authenticated'] } }],
  ['wrong role', { claims: { role: 'service_role' } }],
  ['wrong subject', { claims: { sub: 'authenticated' } }],
  ['wrong issuer', { claims: { iss: 'fixture' } }],
  ['expired', { claims: { iat: now - 60, exp: now } }],
  ['TTL over 60 seconds', { claims: { exp: now + 61 } }],
  ['future issuance', { claims: { iat: now + 1 } }],
])('rejects %s', async (_label, options) => {
  await expect(verify(request(options), key, now)).resolves.toMatchObject({ ok: false, status: 401 });
});

test('rejects a repeated jti even on a freshly signed token', async () => {
  const claims = { jti: randomUUID() };
  await expect(verify(request({ claims }), key, now)).resolves.toEqual({ ok: true });
  await expect(verify(request({ claims: { ...claims, iat: now + 60, exp: now + 120 } }), key, now + 60))
    .resolves.toMatchObject({ ok: false, status: 401 });
});

test('fails closed when the signing key is unavailable', async () => {
  await expect(verify(request(), '', now)).resolves.toMatchObject({ ok: false, status: 503 });
});

test.each([
  ['LABEL_RENDERER_SIGNING_KEY', ['api-caller/index.ts', 'label-renderer/index.ts']],
  ['LABEL_RENDERER_GATEWAY_JWT', ['api-caller/index.ts']],
])('limits Edge references to %s', (name, allowedFiles) => {
  const root = resolve(__dirname, '../../../supabase/functions');
  const references = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => readFileSync(file).includes(name));
  expect(references.sort()).toEqual(allowedFiles.map((file) => join(root, file)));
});
