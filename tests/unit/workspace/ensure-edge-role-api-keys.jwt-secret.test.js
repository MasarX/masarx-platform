const { buildSupabaseApiKeys } = require('../../../scripts/ops/workspace/edge-db-jwt');
const {
  decodeJwtHeaderAlg,
  waitForLegacyApiKeysToMatchSecret,
} = require('../../../scripts/ops/workspace/ensure-edge-role-api-keys');

describe('workspace/ensure-edge-role-api-keys jwt secret helpers', () => {
  test('decodeJwtHeaderAlg returns HS256 for Supabase-style API keys', () => {
    const keys = buildSupabaseApiKeys({ secret: 'secret', issuer: 'supabase', projectRef: 'ref' });
    expect(decodeJwtHeaderAlg(keys.service)).toBe('HS256');
    expect(decodeJwtHeaderAlg(keys.anon)).toBe('HS256');
  });

  test('decodeJwtHeaderAlg returns empty string for invalid JWTs', () => {
    expect(decodeJwtHeaderAlg('')).toBe('');
    expect(decodeJwtHeaderAlg('not-a-jwt')).toBe('');
    expect(decodeJwtHeaderAlg('a.b')).toBe('');
  });

  test('waitForLegacyApiKeysToMatchSecret resolves once keys match the secret', async () => {
    const secretBad = 'bad-secret';
    const secretGood = 'good-secret';
    const issuer = 'supabase';

    const badKeys = buildSupabaseApiKeys({ secret: secretBad, issuer, projectRef: 'ref' });
    const goodKeys = buildSupabaseApiKeys({ secret: secretGood, issuer, projectRef: 'ref' });

    const listApiKeysFn = jest
      .fn()
      .mockResolvedValueOnce([
        { type: 'legacy', name: 'anon', api_key: badKeys.anon },
        { type: 'legacy', name: 'service_role', api_key: badKeys.service },
      ])
      .mockResolvedValueOnce([
        { type: 'legacy', name: 'anon', api_key: goodKeys.anon },
        { type: 'legacy', name: 'service_role', api_key: goodKeys.service },
      ]);

    const res = await waitForLegacyApiKeysToMatchSecret({
      listApiKeysFn,
      projectRef: 'ref',
      token: 'tok',
      secret: secretGood,
      timeoutMs: 250,
      intervalMs: 1,
    });

    expect(res.legacyAnon.api_key).toBe(goodKeys.anon);
    expect(res.legacyService.api_key).toBe(goodKeys.service);
    expect(res.attempts).toBe(2);
  });

  test('waitForLegacyApiKeysToMatchSecret times out without leaking the secret', async () => {
    const secret = 'top-secret-value';
    const wrongKeys = buildSupabaseApiKeys({ secret: 'other', issuer: 'supabase', projectRef: 'ref' });
    const listApiKeysFn = jest.fn().mockResolvedValue([
      { type: 'legacy', name: 'anon', api_key: wrongKeys.anon },
      { type: 'legacy', name: 'service_role', api_key: wrongKeys.service },
    ]);

    let err;
    try {
      await waitForLegacyApiKeysToMatchSecret({
        listApiKeysFn,
        projectRef: 'ref',
        token: 'tok',
        secret,
        timeoutMs: 5,
        intervalMs: 10,
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/timed out/i);
    expect(String(err.message)).not.toContain(secret);
  });
});

