const {
  resolveSigningSecretCandidates,
  buildSupabaseApiBearerCandidates,
  checkRestAuth,
  selectRestAuthCandidateOnce,
  evaluateAuthPlaneCandidate,
  selectAuthPlaneCandidateOnce,
  waitForAuthPlaneCandidate,
  inspectEdgeDbJwtClaims,
  validateEdgeDbJwtBundle,
  resolveAcceptedEdgeDbJwtIssuers,
} = require('../../../scripts/ops/workspace/jwt-rest-auth');
const { createEdgeDbJwt } = require('../../../scripts/ops/workspace/edge-db-jwt');


describe('workspace/jwt-rest-auth', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  test('resolveSigningSecretCandidates includes raw + hex candidates for hex secrets', () => {
    const candidates = resolveSigningSecretCandidates('deadbeef');
    expect(candidates[0]).toEqual(expect.objectContaining({ label: 'raw', secret: 'deadbeef' }));
    expect(candidates.some((c) => c.label === 'hex' && Buffer.isBuffer(c.secret))).toBe(true);
  });

  test('buildSupabaseApiBearerCandidates mints bearer tokens for candidates', () => {
    const candidates = buildSupabaseApiBearerCandidates({
      secretRaw: 'deadbeef',
      issuer: 'supabase',
      projectRef: 'ref',
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(String(c.bearerToken || '')).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    }
  });

  test('checkRestAuth calls /rest/v1 with apikey + bearer token', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await expect(
      checkRestAuth({
        supabaseUrl: 'https://ref.supabase.co',
        apiKey: 'api-key',
        bearerToken: 'bearer-token',
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true, status: 200 }));

    expect(global.fetch).toHaveBeenCalledWith(
      'https://ref.supabase.co/rest/v1/',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          apikey: 'api-key',
          authorization: 'Bearer bearer-token',
        }),
      }),
    );
  });

  test('selectRestAuthCandidateOnce returns the first ok candidate', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'invalid api key' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) });

    const res = await selectRestAuthCandidateOnce({
      supabaseUrl: 'https://ref.supabase.co',
      apiKey: 'api-key',
      candidates: [
        { label: 'one', bearerToken: 'bearer1' },
        { label: 'two', bearerToken: 'bearer2' },
      ],
    });

    expect(res).toEqual(expect.objectContaining({ candidate: expect.objectContaining({ label: 'two' }) }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('evaluateAuthPlaneCandidate reports function JWT rejection separately', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'Invalid JWT' }) });

    const result = await evaluateAuthPlaneCandidate({
      supabaseUrl: 'https://ref.supabase.co',
      restApiKey: 'service-key',
      functionApiKey: 'anon-key',
      bearerToken: 'bearer-token',
      functionName: 'label-renderer',
    });

    expect(result.accepted).toBe(false);
    expect(result.classification).toBe('function:jwt_rejected');
    expect(result.rest.ok).toBe(true);
    expect(result.function.jwtRejected).toBe(true);
  });

  test('selectAuthPlaneCandidateOnce returns candidate with accepted plane', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'invalid JWT' }) })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'invalid JWT' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });

    const res = await selectAuthPlaneCandidateOnce({
      supabaseUrl: 'https://ref.supabase.co',
      restApiKey: 'service-key',
      functionApiKey: 'anon-key',
      candidates: [
        { label: 'bad', bearerToken: 'bad-token' },
        { label: 'good', bearerToken: 'good-token' },
      ],
    });

    expect(res.candidate.label).toBe('good');
    expect(res.evaluation.accepted).toBe(true);
  });

  test('waitForAuthPlaneCandidate retries until accepted', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'invalid JWT' }) })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'invalid JWT' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });

    const res = await waitForAuthPlaneCandidate({
      supabaseUrl: 'https://ref.supabase.co',
      restApiKey: 'service-key',
      functionApiKey: 'anon-key',
      candidates: [{ label: 'candidate', bearerToken: 'token' }],
      timeoutMs: 200,
      intervalMs: 1,
    });

    expect(res.evaluation.accepted).toBe(true);
    expect(res.attempts).toBeGreaterThanOrEqual(2);
  });
const NOW = 1_800_000_000;
const SECRET = 'edge-db-jwt-test-secret';

function scopedBundle(overrides = {}) {
  const build = (role) => createEdgeDbJwt({
    secret: SECRET,
    role,
    issuer: 'supabase',
    nowSec: NOW,
    ttlSec: 10_800,
  });
  return {
    WEBHOOK_DB_JWT: build('edge_webhook_role'),
    API_CALLER_DB_JWT: build('edge_api_caller_role'),
    API_GATEWAY_DB_JWT: build('edge_api_gateway_role'),
    LABEL_RENDERER_DB_JWT: build('edge_label_renderer_role'),
    ...overrides,
  };
}

  test.each([
    ['wrong role', { role: 'service_role' }, 'role'],
    ['wrong issuer', { issuer: 'other' }, 'issuer'],
    ['wrong audience', { audience: 'anon' }, 'audience'],
    ['wrong subject', { subject: 'user' }, 'subject'],
    ['future issued-at', { nowSec: NOW + 120 }, 'issued_at'],
    ['near expiry', { ttlSec: 60 }, 'expiry'],
  ])('inspectEdgeDbJwtClaims rejects %s', (_label, overrides, reason) => {
    const token = createEdgeDbJwt({
      secret: SECRET,
      role: overrides.role || 'edge_api_caller_role',
      issuer: overrides.issuer || 'supabase',
      nowSec: overrides.nowSec || NOW,
      ttlSec: overrides.ttlSec || 10_800,
    });
    let adjusted = token;
    if (overrides.audience || overrides.subject) {
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (overrides.audience) payload.aud = overrides.audience;
      if (overrides.subject) payload.sub = overrides.subject;
      adjusted = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
    }
    expect(inspectEdgeDbJwtClaims({
      name: 'API_CALLER_DB_JWT',
      token: adjusted,
      expectedRole: 'edge_api_caller_role',
      expectedIssuer: 'supabase',
      nowSec: NOW,
    })).toMatchObject({ valid: false, reason });
  });

  test.each([
    ['role case variant', { role: 'EDGE_API_CALLER_ROLE' }, 'role'],
    ['algorithm case variant', { algorithm: 'hs256' }, 'algorithm'],
    ['string issued-at', { iat: String(NOW) }, 'issued_at'],
    ['string expiry', { exp: String(NOW + 10_800) }, 'expiry'],
    ['expired token', { exp: NOW - 1 }, 'expiry'],
    ['non-positive lifetime', { iat: NOW, exp: NOW }, 'expiry'],
    ['excessive lifetime', { exp: NOW + (367 * 24 * 60 * 60) }, 'lifetime'],
  ])('inspectEdgeDbJwtClaims rejects exact-contract %s', (_label, patch, reason) => {
    const token = createEdgeDbJwt({
      secret: SECRET,
      role: 'edge_api_caller_role',
      issuer: 'supabase',
      nowSec: NOW,
      ttlSec: 10_800,
    });
    const [headerPart, payloadPart, signature] = token.split('.');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (patch.algorithm !== undefined) header.alg = patch.algorithm;
    Object.assign(payload, Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'algorithm')));
    const adjusted = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
    expect(inspectEdgeDbJwtClaims({
      name: 'API_CALLER_DB_JWT',
      token: adjusted,
      expectedRole: 'edge_api_caller_role',
      expectedIssuer: 'supabase',
      nowSec: NOW,
    })).toMatchObject({ valid: false, reason });
  });

  test('requires explicit project binding for legacy issuers and accepts the canonical hosted issuer', () => {
    const legacy = createEdgeDbJwt({
      secret: SECRET,
      role: 'edge_api_caller_role',
      issuer: 'supabase',
      nowSec: NOW,
      ttlSec: 10_800,
    });
    expect(inspectEdgeDbJwtClaims({
      name: 'API_CALLER_DB_JWT', token: legacy, expectedRole: 'edge_api_caller_role',
      expectedIssuer: 'supabase', projectRef: 'ref', nowSec: NOW,
    })).toMatchObject({ valid: false, reason: 'project_ref' });
    const hosted = createEdgeDbJwt({
      secret: SECRET,
      role: 'edge_api_caller_role',
      issuer: 'https://ref.supabase.co/auth/v1',
      nowSec: NOW,
      ttlSec: 10_800,
    });
    expect(inspectEdgeDbJwtClaims({
      name: 'API_CALLER_DB_JWT', token: hosted, expectedRole: 'edge_api_caller_role',
      expectedIssuer: 'supabase', projectRef: 'ref', nowSec: NOW,
    })).toMatchObject({ valid: true, project_ref_match: true });
  });

  test('validateEdgeDbJwtBundle verifies trusted signatures without network calls', async () => {
    const checkRestAuthFn = jest.fn();
    await expect(validateEdgeDbJwtBundle({
      env: scopedBundle(),
      expectedIssuer: 'supabase',
      signingSecret: SECRET,
      nowSec: NOW,
      checkRestAuthFn,
    })).resolves.toMatchObject({ valid: true, validation: 'signature' });
    expect(checkRestAuthFn).not.toHaveBeenCalled();
  });

  test('validateEdgeDbJwtBundle rejects a tampered signature', async () => {
    const env = scopedBundle();
    env.API_GATEWAY_DB_JWT = `${env.API_GATEWAY_DB_JWT.slice(0, -1)}x`;
    await expect(validateEdgeDbJwtBundle({
      env,
      expectedIssuer: 'supabase',
      signingSecret: SECRET,
      nowSec: NOW,
    })).rejects.toThrow(/signature validation failed: API_GATEWAY_DB_JWT/i);
  });

  test('validateEdgeDbJwtBundle live-validates all four tokens in parallel and reports no secrets', async () => {
    let active = 0;
    let peak = 0;
    const checkRestAuthFn = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, status: 200, body: {} };
    });
    const env = scopedBundle();
    const result = await validateEdgeDbJwtBundle({
      env,
      supabaseUrl: 'https://ref.supabase.co',
      apiKey: 'publishable-key',
      expectedIssuer: 'supabase',
      nowSec: NOW,
      checkRestAuthFn,
    });
    expect(result).toMatchObject({ valid: true, validation: 'live_rest' });
    expect(checkRestAuthFn).toHaveBeenCalledTimes(4);
    expect(peak).toBeGreaterThan(1);
    expect(JSON.stringify(result)).not.toContain(env.API_CALLER_DB_JWT);
  });

  test('derives canonical hosted issuers without dropping an explicit legacy issuer', () => {
    expect(resolveAcceptedEdgeDbJwtIssuers({
      expectedIssuer: 'supabase',
      supabaseUrl: 'https://ref.supabase.co',
      projectRef: 'ref',
    })).toEqual([
      'supabase',
      'https://ref.supabase.co/auth/v1',
    ]);
  });

  test.each(['ES256', 'RS256'])(
    'validateEdgeDbJwtBundle accepts realistic %s tokens only through hosted validation',
    async (algorithm) => {
    const env = scopedBundle();
    for (const key of Object.keys(env)) {
      const [, payload] = env[key].split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      claims.iss = 'https://ref.supabase.co/auth/v1';
      claims.ref = 'ref';
      const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: 'JWT', kid: 'hosted-test-key' }))
        .toString('base64url');
      env[key] = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.hosted-signature`;
    }
    const checkRestAuthFn = jest.fn(async () => ({ ok: true, status: 200, body: {} }));
    await expect(validateEdgeDbJwtBundle({
      env,
      supabaseUrl: 'https://ref.supabase.co',
      apiKey: 'publishable-key',
      expectedIssuer: 'supabase',
      projectRef: 'ref',
      signingSecret: SECRET,
      nowSec: NOW,
      checkRestAuthFn,
    })).resolves.toMatchObject({ valid: true, validation: 'live_rest' });
    expect(checkRestAuthFn).toHaveBeenCalledTimes(4);
    },
  );

  test('validateEdgeDbJwtBundle fails closed after bounded live rejection', async () => {
    const checkRestAuthFn = jest.fn(async () => ({ ok: false, status: 401, body: { message: 'invalid JWT' } }));
    const env = scopedBundle();
    await expect(validateEdgeDbJwtBundle({
      env,
      supabaseUrl: 'https://ref.supabase.co',
      apiKey: 'publishable-key',
      expectedIssuer: 'supabase',
      nowSec: NOW,
      probeAttempts: 2,
      probeRetryDelayMs: 1,
      checkRestAuthFn,
    })).rejects.toThrow(/bundle validation failed \(4\/4\).*WEBHOOK_DB_JWT.*API_CALLER_DB_JWT.*API_GATEWAY_DB_JWT.*LABEL_RENDERER_DB_JWT/i);
    expect(checkRestAuthFn).toHaveBeenCalledTimes(8);
    await validateEdgeDbJwtBundle({
      env,
      supabaseUrl: 'https://ref.supabase.co',
      apiKey: 'publishable-key',
      expectedIssuer: 'supabase',
      nowSec: NOW,
      probeAttempts: 1,
      checkRestAuthFn,
    }).catch((error) => {
      expect(error.message).not.toContain(env.WEBHOOK_DB_JWT);
      expect(error.message).not.toContain(env.API_CALLER_DB_JWT);
      expect(error.message).not.toContain(env.API_GATEWAY_DB_JWT);
      expect(error.message).not.toContain(env.LABEL_RENDERER_DB_JWT);
    });
  });
});
