const {
  buildCsp,
  buildSecurityHeaders,
  buildStaticSecurityHeaders,
  normalizeOrigin,
  resolveWebsocketOrigin,
} = require('../../../apps/shared/security-headers');

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
  test('normalizeOrigin returns URL origin and null for invalid values', () => {
    expect(normalizeOrigin('https://example.com/path?x=1')).toBe('https://example.com');
    expect(normalizeOrigin('not-a-url')).toBeNull();
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
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
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
