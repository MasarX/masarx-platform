const {
  isLikelyJwtToken,
  isServiceRoleJwtToken,
  isSupabaseSecretKey,
  selectAdminServiceKeyFromApiKeys,
  selectLegacyServiceRoleKeyFromApiKeys,
  selectSecretAdminKeyFromApiKeys,
  splitSupabaseApiKeys,
} = require('../../../scripts/ops/workspace/supabase-admin-keys');

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload || {})).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('supabase-admin-keys helpers', () => {
  test('detects JWT, service-role JWT, and secret-key shapes', () => {
    expect(isLikelyJwtToken('a.b.c')).toBe(true);
    expect(isLikelyJwtToken('sb_secret_abc')).toBe(false);
    expect(isSupabaseSecretKey('sb_secret_abc')).toBe(true);
    expect(isSupabaseSecretKey(makeJwt({ role: 'service_role' }))).toBe(false);
    expect(isServiceRoleJwtToken(makeJwt({ role: 'service_role' }))).toBe(true);
    expect(isServiceRoleJwtToken(makeJwt({ role: 'anon' }))).toBe(false);
  });

  test('prefers legacy service-role JWT over modern secret keys', () => {
    const serviceRoleJwt = makeJwt({ role: 'service_role', ref: 'proj' });
    expect(
      selectLegacyServiceRoleKeyFromApiKeys({
        legacyService: serviceRoleJwt,
        secret: 'sb_secret_modern',
      }),
    ).toBe(serviceRoleJwt);
  });

  test('selects modern secret key from secret or service candidates', () => {
    expect(selectSecretAdminKeyFromApiKeys({ secret: 'sb_secret_modern' })).toBe(
      'sb_secret_modern',
    );
    expect(selectSecretAdminKeyFromApiKeys({ service: 'sb_secret_service' })).toBe(
      'sb_secret_service',
    );
  });

  test('prefers legacy JWT by default but supports preferSecret override', () => {
    const serviceRoleJwt = makeJwt({ role: 'service_role', ref: 'proj' });

    expect(
      selectAdminServiceKeyFromApiKeys({
        legacyService: serviceRoleJwt,
        secret: 'sb_secret_modern',
      }),
    ).toBe(serviceRoleJwt);

    expect(
      selectAdminServiceKeyFromApiKeys(
        {
          legacyService: serviceRoleJwt,
          secret: 'sb_secret_modern',
        },
        { preferSecret: true },
      ),
    ).toBe('sb_secret_modern');
  });

  test('splits publishable, legacy service role, and secret admin keys', () => {
    const serviceRoleJwt = makeJwt({ role: 'service_role', ref: 'proj' });
    expect(
      splitSupabaseApiKeys({
        publishable: 'sb_publishable_live',
        legacyService: serviceRoleJwt,
        secret: 'sb_secret_live',
      }),
    ).toEqual({
      anonKey: 'sb_publishable_live',
      serviceRoleKey: serviceRoleJwt,
      secretKey: 'sb_secret_live',
      adminServiceKey: serviceRoleJwt,
    });
  });
});
