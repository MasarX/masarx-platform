const {
  resolveSigningSecretCandidates,
  buildSupabaseApiBearerCandidates,
  checkRestAuth,
  selectRestAuthCandidateOnce,
  evaluateAuthPlaneCandidate,
  selectAuthPlaneCandidateOnce,
  waitForAuthPlaneCandidate,
} = require('../../../scripts/ops/workspace/jwt-rest-auth');

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
});
