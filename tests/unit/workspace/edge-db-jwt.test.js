const {
  createEdgeDbJwt,
  buildEdgeDbJwtBundle,
  deriveProjectJwtSecret,
  generateJwtSecret,
  buildSupabaseApiKeys,
  resolveJwtIssuer,
  resolveJwtSigningSecret,
  isJwtSignedWithSecret,
} = require('../../../scripts/ops/workspace/edge-db-jwt');

function decodeBase64Url(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

describe('edge-db-jwt', () => {
  test('createEdgeDbJwt signs a role-scoped payload', () => {
    const token = createEdgeDbJwt({
      secret: 'test-secret',
      role: 'edge_webhook_role',
      nowSec: 1700000000,
      ttlSec: 3600,
    });
    const [headerPart, payloadPart, signaturePart] = token.split('.');
    expect(headerPart).toBeTruthy();
    expect(payloadPart).toBeTruthy();
    expect(signaturePart).toBeTruthy();
    const header = JSON.parse(decodeBase64Url(headerPart));
    const payload = JSON.parse(decodeBase64Url(payloadPart));
    expect(header).toMatchObject({ alg: 'HS256', typ: 'JWT' });
    expect(payload).toMatchObject({
      role: 'edge_webhook_role',
      iss: 'supabase',
      sub: 'edge-function',
      aud: 'authenticated',
      iat: 1700000000,
      exp: 1700003600,
    });
  });

  test('buildEdgeDbJwtBundle returns per-function tokens', () => {
    const bundle = buildEdgeDbJwtBundle({ secret: 'bundle-secret', nowSec: 1, ttlSec: 2 });
    expect(bundle).toEqual(
      expect.objectContaining({
        webhook_db_jwt: expect.any(String),
        api_caller_db_jwt: expect.any(String),
        api_gateway_db_jwt: expect.any(String),
        label_renderer_db_jwt: expect.any(String),
      })
    );
    const payload = JSON.parse(decodeBase64Url(bundle.webhook_db_jwt.split('.')[1]));
    expect(payload.role).toBe('edge_webhook_role');
  });

  test('builds a signed database JWT for the dedicated marketing role', () => {
    const secret = 'marketing-bundle-fixture';
    const { marketing_db_jwt: token } = buildEdgeDbJwtBundle({ secret, nowSec: 1, ttlSec: 2, includeMarketing: true });
    expect(isJwtSignedWithSecret(token, secret)).toBe(true);
    expect(JSON.parse(decodeBase64Url(token.split('.')[1]))).toMatchObject({
      role: 'edge_marketing_role',
      exp: 3,
    });
  });

  test('resolveJwtIssuer uses issuer from service key', () => {
    const token = createEdgeDbJwt({
      secret: 'issuer-secret',
      role: 'edge_webhook_role',
      nowSec: 1700000000,
      ttlSec: 3600,
      issuer: 'supabase',
    });
    expect(resolveJwtIssuer({ serviceKey: token })).toBe('supabase');
  });

  test('resolveJwtSigningSecret prefers raw secret when it matches', () => {
    const secret = 'raw-secret';
    const serviceKey = createEdgeDbJwt({
      secret,
      role: 'service_role',
      nowSec: 1700000000,
      ttlSec: 3600,
      issuer: 'supabase',
    });
    const resolved = resolveJwtSigningSecret({ secret, serviceKey });
    expect(resolved).toBe(secret);
  });

  test('resolveJwtSigningSecret uses base64-decoded secret when it matches', () => {
    const raw = 'raw-secret';
    const base64Secret = Buffer.from(raw).toString('base64');
    const serviceKey = createEdgeDbJwt({
      secret: Buffer.from(base64Secret, 'base64'),
      role: 'service_role',
      nowSec: 1700000000,
      ttlSec: 3600,
      issuer: 'supabase',
    });
    const resolved = resolveJwtSigningSecret({ secret: base64Secret, serviceKey });
    expect(Buffer.isBuffer(resolved)).toBe(true);
    expect(resolved.toString('utf8')).toBe(raw);
  });

  test('resolveJwtSigningSecret uses hex-decoded secret when it matches', () => {
    const raw = 'raw-secret';
    const hexSecret = Buffer.from(raw).toString('hex');
    const serviceKey = createEdgeDbJwt({
      secret: Buffer.from(hexSecret, 'hex'),
      role: 'service_role',
      nowSec: 1700000000,
      ttlSec: 3600,
      issuer: 'supabase',
    });
    const resolved = resolveJwtSigningSecret({ secret: hexSecret, serviceKey });
    expect(Buffer.isBuffer(resolved)).toBe(true);
    expect(resolved.toString('utf8')).toBe(raw);
  });

  test('buildSupabaseApiKeys creates anon/service role tokens', () => {
    const keys = buildSupabaseApiKeys({
      secret: 'api-secret',
      nowSec: 1700000000,
      ttlSec: 3600,
      issuer: 'supabase',
      projectRef: 'test-ref',
    });
    expect(keys).toEqual(expect.objectContaining({ anon: expect.any(String), service: expect.any(String) }));
    const anonPayload = JSON.parse(decodeBase64Url(keys.anon.split('.')[1]));
    const servicePayload = JSON.parse(decodeBase64Url(keys.service.split('.')[1]));
    expect(anonPayload).toMatchObject({
      role: 'anon',
      iss: 'supabase',
      ref: 'test-ref',
      iat: 1700000000,
      exp: 1700003600,
    });
    expect(servicePayload).toMatchObject({
      role: 'service_role',
      iss: 'supabase',
      ref: 'test-ref',
      iat: 1700000000,
      exp: 1700003600,
    });
    expect(anonPayload.aud).toBeUndefined();
    expect(servicePayload.aud).toBeUndefined();
  });

  test('isJwtSignedWithSecret validates token signatures', () => {
    const secret = 'signing-secret';
    const token = createEdgeDbJwt({
      secret,
      role: 'edge_webhook_role',
      nowSec: 1700000000,
      ttlSec: 3600,
    });
    expect(isJwtSignedWithSecret(token, secret)).toBe(true);
    expect(isJwtSignedWithSecret(token, 'wrong-secret')).toBe(false);
  });

  test('deriveProjectJwtSecret is deterministic for project refs', () => {
    const first = deriveProjectJwtSecret({ seed: 'root-secret', projectRef: 'abc123' });
    const second = deriveProjectJwtSecret({ seed: 'root-secret', projectRef: 'abc123' });
    const different = deriveProjectJwtSecret({ seed: 'root-secret', projectRef: 'xyz789' });
    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });

  test('generateJwtSecret returns non-empty string', () => {
    const secret = generateJwtSecret();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(0);
  });
});
