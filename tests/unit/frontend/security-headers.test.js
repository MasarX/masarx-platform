const {
  buildCsp,
  buildSecurityHeaders,
  buildStaticSecurityHeaders,
  isLoopbackHostname,
  normalizeOrigin,
  normalizeTrustedOrigin,
  resolveTrustedExternalDataOrigins,
  resolveWebsocketOrigin,
} = require('../../../apps/shared/security-headers');
const loopbackHostnameContract = require('../../fixtures/loopback-hostname-contract.json');

function parseCsp(value) {
  const directives = new Map();
  for (const part of String(value || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...rest] = trimmed.split(/\s+/);
    directives.set(name, rest);
  }
  return directives;
}

describe('apps/shared/security-headers', () => {
  test('follows the canonical loopback hostname contract', () => {
    for (const hostname of loopbackHostnameContract.accepted) {
      expect(isLoopbackHostname(hostname)).toBe(true);
    }
    for (const hostname of loopbackHostnameContract.rejected) {
      expect(isLoopbackHostname(hostname)).toBe(false);
    }
  });

  test('normalizeOrigin returns URL origin and null for invalid values', () => {
    expect(normalizeOrigin('https://example.com/path?x=1')).toBe('https://example.com');
    expect(normalizeOrigin('not-a-url')).toBeNull();
  });

  test('trusted external data origins are exact and reject ambiguous configuration', () => {
    expect(normalizeTrustedOrigin('https://cdn.example.com/')).toBe(
      'https://cdn.example.com'
    );
    expect(normalizeTrustedOrigin('https://cdn.example.com/path')).toBeNull();
    expect(normalizeTrustedOrigin('https://tvszulqnxjwtxxpssuwtsxts@example.invalid')).toBeNull();
    expect(normalizeTrustedOrigin('//cdn.example.com')).toBeNull();
    expect(normalizeTrustedOrigin('http://cdn.example.com')).toBeNull();
    expect(normalizeTrustedOrigin('http://foo.localhost')).toBe(
      'http://foo.localhost'
    );
    expect(normalizeTrustedOrigin('http://localhost.')).toBe(
      'http://localhost.'
    );
    expect(normalizeTrustedOrigin('http://127.0.0.2')).toBe(
      'http://127.0.0.2'
    );
    expect(normalizeTrustedOrigin('http://[::ffff:7f00:1]')).toBe(
      'http://[::ffff:7f00:1]'
    );
    expect(normalizeTrustedOrigin('http://localhost:54321')).toBe(
      'http://localhost:54321'
    );
    expect(
      resolveTrustedExternalDataOrigins({
        supabaseUrl: 'https://abc.supabase.co',
        configuredOrigins:
          'https://cdn.example.com,https://cdn.example.com/,https://files.example.com:8443,http://127.0.0.1:54321,http://cdn-cleartext.example.com,https://bad.example.com/path',
      })
    ).toEqual([
      'https://abc.supabase.co',
      'https://cdn.example.com',
      'https://files.example.com:8443',
      'http://127.0.0.1:54321',
    ]);
  });

  test('resolveWebsocketOrigin maps http/https to ws/wss', () => {
    expect(resolveWebsocketOrigin('https://supabase.example')).toBe('wss://supabase.example');
    expect(resolveWebsocketOrigin('http://localhost:54321')).toBe('ws://localhost:54321');
    expect(resolveWebsocketOrigin(null)).toBeNull();
  });

  test('buildCsp keeps unsafe-eval in development for Next dev tooling', () => {
    const csp = parseCsp(buildCsp({
      supabaseUrl: 'https://abc.supabase.co',
      nodeEnv: 'development',
    }));
    expect(csp.get('script-src')).toEqual(expect.arrayContaining(["'unsafe-eval'"]));
    expect(csp.get('connect-src')).toEqual(
      expect.arrayContaining(["'self'", 'https://abc.supabase.co', 'wss://abc.supabase.co'])
    );
  });

  test('buildCsp hardens production directives', () => {
    const csp = parseCsp(buildCsp({
      supabaseUrl: 'https://abc.supabase.co',
      nodeEnv: 'production',
      nonce: 'testnonce',
    }));
    expect(csp.get('script-src')).not.toContain("'unsafe-eval'");
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
    expect(csp.get('script-src')).toEqual(
      expect.arrayContaining(["'self'", "'nonce-testnonce'", "'strict-dynamic'"])
    );
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('frame-src')).toEqual(["'none'"]);
    expect(csp.get('img-src')).toEqual(
      expect.arrayContaining([
        "'self'",
        'data:',
        'blob:',
        'https://abc.supabase.co',
      ])
    );
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
  });

  test('buildCsp preserves the default style, font and worker directives', () => {
    const csp = parseCsp(buildCsp({ nodeEnv: 'production' }));
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp.get('font-src')).toEqual(["'self'", 'data:']);
    expect(csp.has('worker-src')).toBe(false);
  });

  test('buildCsp adds only exact HTTPS font origins and opts in to same-origin workers', () => {
    const invalid = 'http://cleartext.example.test,https://path.example.test/fonts,https://*.example.test';
    const csp = parseCsp(buildCsp({
      nodeEnv: 'production',
      fontStylesheetOrigins: `https://styles.example.test/,${invalid}`,
      fontAssetOrigins: `https://fonts.example.test:8443,${invalid}`,
      sameOriginWorkers: true,
    }));
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'", 'https://styles.example.test']);
    expect(csp.get('font-src')).toEqual(["'self'", 'data:', 'https://fonts.example.test:8443']);
    expect(csp.get('worker-src')).toEqual(["'self'"]);
  });

  test('map raster fetch admission is explicit and does not widen image-only origins', () => {
    const csp = parseCsp(buildCsp({ supabaseUrl: '', nodeEnv: 'production',
      trustedExternalDataOrigins: 'https://images.example.test',
      mapTileOrigins: 'https://tiles.example.test,https://tiles.example.test/,https://tiles.example.test:8443',
    }));
    expect(csp.get('connect-src')).toEqual(["'self'",'https://tiles.example.test','https://tiles.example.test:8443']);
    expect(csp.get('img-src')).not.toContain('https://tiles.example.test');
    expect(csp.get('connect-src')).not.toContain('https://images.example.test');
  });
  test.each(['https://*.example.test','https://user@tiles.example.test','https://tiles.example.test/path',
    'https://tiles.example.test?x=1','https://tiles.example.test#x','http://tiles.example.test',
    '//tiles.example.test','https://tiles.example.test/../','https://tiles.example.test\\evil',
    "https://tiles.example.test; script-src *"])( 'rejects invalid map origin %s', mapTileOrigins => {
    expect(parseCsp(buildCsp({supabaseUrl:'',nodeEnv:'production',mapTileOrigins})).get('connect-src')).toEqual(["'self'"]);
  });
  test('map origins have no implicit provider default', () => {
    expect(parseCsp(buildCsp({supabaseUrl:'',nodeEnv:'production',mapTileOrigins:''})).get('connect-src')).toEqual(["'self'"]);
  });
  test('buildCsp adds only configured trusted external data origins to img-src', () => {
    const csp = parseCsp(buildCsp({
      supabaseUrl: 'https://abc.supabase.co',
      nodeEnv: 'production',
      nonce: 'testnonce',
      trustedExternalDataOrigins:
        (['https',":","/","/",'cdn.example.com,https',":","/","/",'files.example.com',":",'8443,https',":","/","/",'ropuigqyklxliwvgywhshqyv',"@",'example.invalid,https',":","/","/",'bad.example.com',"/",'path'].join("")),
    }));

    expect(csp.get('img-src')).toEqual([
      "'self'",
      'data:',
      'blob:',
      'https://abc.supabase.co',
      'https://cdn.example.com',
      'https://files.example.com:8443',
    ]);
  });

  test('buildCsp resolves trusted external data origins lazily from public env', () => {
    const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousConfiguredOrigins =
      process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
      process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
        'https://cdn.example.com';
      const first = parseCsp(buildCsp({ nodeEnv: 'production' }));
      expect(first.get('img-src')).toEqual(
        expect.arrayContaining([
          'https://abc.supabase.co',
          'https://cdn.example.com',
        ])
      );

      process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
        'https://other.example.com';
      const second = parseCsp(buildCsp({ nodeEnv: 'production' }));
      expect(second.get('img-src')).not.toContain('https://cdn.example.com');
      expect(second.get('img-src')).toContain('https://other.example.com');
    } finally {
      if (previousSupabaseUrl === undefined) {
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      } else {
        process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
      }
      if (previousConfiguredOrigins === undefined) {
        delete process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
      } else {
        process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
          previousConfiguredOrigins;
      }
    }
  });

  test('buildSecurityHeaders exposes baseline hardening headers', () => {
    const headers = buildSecurityHeaders({
      supabaseUrl: 'https://abc.supabase.co',
      nodeEnv: 'production',
      nonce: 'testnonce',
    });
    const byKey = new Map(headers.map((entry) => [entry.key, entry.value]));

    expect(byKey.get('Content-Security-Policy')).toEqual(expect.any(String));
    expect(byKey.get('X-Frame-Options')).toBe('DENY');
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff');
    expect(byKey.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(byKey.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(byKey.get('Origin-Agent-Cluster')).toBe('?1');
  });

  test('buildStaticSecurityHeaders omits CSP for middleware-managed apps', () => {
    const headers = buildStaticSecurityHeaders();
    const byKey = new Map(headers.map((entry) => [entry.key, entry.value]));
    expect(byKey.has('Content-Security-Policy')).toBe(false);
    expect(byKey.get('X-Frame-Options')).toBe('DENY');
  });
});
