const fs = require('fs');
const path = require('path');

// These deliberately unsigned tokens exercise decoded claim policy, NOT native JWT verification.
const nowSeconds = 2_000_000_000;
const claims = (overrides = {}) => ({
  role: 'edge_label_renderer_role', aud: 'authenticated', sub: 'edge-function',
  exp: nowSeconds + 300, ...overrides,
});
const token = (value) => 'header.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.unsigned';
const request = (value) => new Request('https://example.test/functions/v1/label-renderer', {
  method: 'POST', headers: { authorization: 'Bearer ' + token(value) },
});
let authorize;
let operation;
let apiAuthorize;
let apiOperation;
const originalRoles = process.env.EDGE_INTERNAL_CALLER_ROLES;
beforeAll(async () => {
  ({ authorizeLabelRendererRequest: authorize, resolveLabelRendererOperation: operation } =
    await import('../../../supabase/functions/label-renderer/auth.mjs'));
  ({ authorizeEdgeRequest: apiAuthorize, authorizeApiCallerOperation: apiOperation } =
    await import('../../../supabase/functions/api-caller/auth.mjs'));
});
afterEach(() => {
  if (originalRoles === undefined) delete process.env.EDGE_INTERNAL_CALLER_ROLES;
  else process.env.EDGE_INTERNAL_CALLER_ROLES = originalRoles;
});
const check = (value, options = {}, op = 'jobs') => authorize(request(value), op, { nowSeconds, ...options });

describe('renderer native-admitted claim defense', () => {
  test.each(['print', 'bundle', 'jobs'])('allows renderer %s operations in both DB-JWT modes', (op) => {
    for (const requireDbJwt of [false, true]) expect(check(claims(), { requireDbJwt }, op).ok).toBe(true);
  });
  test.each(['print', 'bundle', 'jobs'])('preserves service-role compatibility for %s only outside strict DB-JWT mode', (op) => {
    const service = claims({ role: 'service_role', aud: undefined, sub: undefined });
    expect(check(service, { requireDbJwt: false }, op).ok).toBe(true);
    expect(check(service, { requireDbJwt: true }, op)).toMatchObject({ ok: false, status: 403 });
  });
  test.each([
    ['missing audience', { aud: undefined }, 403],
    ['wrong audience', { aud: 'anon' }, 403],
    ['missing subject', { sub: undefined }, 403],
    ['user subject', { sub: 'user-id' }, 403],
    ['missing expiry', { exp: undefined }, 401],
    ['invalid expiry', { exp: 'not-a-number' }, 401],
    ['expiry boundary', { exp: nowSeconds }, 401],
    ['expired', { exp: nowSeconds - 1 }, 401],
    ['future not-before', { nbf: nowSeconds + 1 }, 401],
    ['invalid not-before', { nbf: 'not-a-number' }, 401],
    ['ordinary user', { role: 'authenticated' }, 403],
    ['other machine', { role: 'edge_api_caller_role' }, 403],
    ['missing role', { role: undefined }, 401],
  ])('rejects %s', (_label, override, status) => {
    expect(check(claims(override))).toMatchObject({ ok: false, status });
  });
  test.each([
    { aud: ['other', 'Authenticated'], nbf: nowSeconds },
    { aud: ' Authenticated ', sub: ' EDGE-FUNCTION ', nbf: null },
    { nbf: nowSeconds - 1 },
    { role: undefined, user_role: 'edge_label_renderer_role' },
  ])('retains supported claim normalization %#', (override) => {
    expect(check(claims(override)).ok).toBe(true);
  });
  test.each([{ aud: 'anon' }, { sub: 'user-id' }, { exp: nowSeconds }, { nbf: nowSeconds + 1 }])(
    'service-role compatibility does not permit contradictory claims %#', (override) => {
      expect(check(claims({ role: 'service_role', ...override })).ok).toBe(false);
    },
  );
  test.each(['designer_preview', 'batch', '', 'unknown'])('does not authorize non-machine operation %s', (op) => {
    expect(check(claims(), {}, op)).toMatchObject({ ok: false, status: 403 });
  });
  test('requires a bearer header, not alternate webhook/query credentials', () => {
    for (const req of [
      new Request('https://example.test'),
      new Request('https://example.test/?token=' + token(claims()), { headers: { 'x-webhook-token': token(claims()) } }),
      new Request('https://example.test', { headers: { authorization: 'Bearer invalid-token' } }),
    ]) expect(authorize(req, 'jobs', { nowSeconds })).toMatchObject({ ok: false, status: 401 });
  });
  test.each([
    [{ print: {} }, 'print'], [{ mode: 'print' }, 'print'],
    [{ bundle: {} }, 'bundle'], [{ mode: 'bundle' }, 'bundle'],
    [{ print: null, bundle: {} }, 'print'], [{ mode: 'bundle', print: false }, 'print'],
    [{ job_id: 'job' }, 'jobs'], [{ job_ids: ['a', 'b'] }, 'jobs'],
    [{ max_jobs: 10 }, 'jobs'], [{ mode: 'legacy-value' }, 'jobs'], [null, 'jobs'],
  ])('preserves existing payload dispatch %#', (payload, expected) => {
    expect(operation(payload)).toBe(expected);
  });
  test('handler keeps preview/OPTIONS/smoke separate and guards business dispatch', () => {
    const body = fs.readFileSync(path.resolve(__dirname, '../../../supabase/functions/label-renderer/index.ts'), 'utf8');
    const auth = body.indexOf('const authorization = authorizeLabelRendererRequest(req, operation,');
    for (const marker of [
      'const previewResult = await handleDesignerPreview(payload);',
      'smokeAllow === "1" && smokeHeader === "edge-allow"',
      'req.method === "OPTIONS"',
    ]) {
      const bypass = body.indexOf(marker);
      expect(bypass).toBeGreaterThanOrEqual(0);
      expect(auth).toBeGreaterThan(bypass);
    }
    expect(body.indexOf('if (operation === "print")', auth)).toBeGreaterThan(auth);
    expect(body.indexOf('if (operation === "bundle")', auth)).toBeGreaterThan(auth);
    expect(body.indexOf('const client = ensureSupabase();', auth)).toBeGreaterThan(auth);
    expect(body).toContain('userClient.rpc("label_designer_whoami").single()');
  });
});

describe('API-caller compatibility after shared claim extraction', () => {
  test.each(['edge_api_caller_role', 'edge_api_gateway_role', 'edge_webhook_role', 'service_role'])('preserves role-local operations for %s', async (role) => {
    process.env.EDGE_INTERNAL_CALLER_ROLES = role;
    const value = claims({ role, ...(role === 'service_role' ? { aud: undefined, sub: undefined } : {}) });
    const auth = await apiAuthorize(request(value), { nowSeconds });
    expect(auth.ok).toBe(true);
    expect(apiOperation(auth, 'job').ok).toBe(true);
    expect(apiOperation(auth, 'batch').ok).toBe(['edge_api_caller_role', 'service_role'].includes(role));
  });
  test('does not grant renderer roles API-caller operations through an env allowlist', async () => {
    process.env.EDGE_INTERNAL_CALLER_ROLES = 'edge_label_renderer_role';
    const auth = await apiAuthorize(request(claims()), { nowSeconds });
    expect(auth).toMatchObject({ ok: false, status: 403, message: 'Role is not authorized for api-caller' });
  });
});
