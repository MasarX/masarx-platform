const path = require('path');
const { build } = require('esbuild');

describe('tenant signup hosted invite redirects', () => {
  let normalizeHostedRedirectUrl;

  beforeAll(async () => {
    // Bundle the real Deno helper and its local imports; type-only npm imports
    // disappear without requiring a Deno runtime or Supabase credentials.
    const result = await build({
      entryPoints: [path.join(__dirname, '../../../supabase/functions/_shared/tenant_signup.ts')],
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'esm',
      target: 'es2022',
    });
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
    ({ normalizeHostedRedirectUrl } = await import(moduleUrl));
  });

  test.each([
    'https://localhost/callback',
    'https://localhost./callback',
    'https://tenant.localhost/callback',
    'https://tenant.localhost./callback',
    'https://tenant.local/callback',
    'https://tenant.local./callback',
    'https://0.0.0.0/callback',
    'https://127.0.0.1/callback',
    'https://127.0.0.2/callback',
    'https://127.255.255.254/callback',
    'https://[::1]/callback',
    'https://[::ffff:127.0.0.2]/callback',
    'https://[::ffff:7fff:fffe]/callback',
  ])('rejects local invite redirect %s', (url) => {
    expect(normalizeHostedRedirectUrl(url)).toBe('');
  });

  test.each([
    ['https://portal.example.com/invite?token=example#fragment', 'https://portal.example.com/invite?token=example'],
    ['https://[2606:4700:4700::1111]/callback', 'https://[2606:4700:4700::1111]/callback'],
    ['https://localhost.example.com/callback', 'https://localhost.example.com/callback'],
  ])('preserves hosted invite redirect %s', (url, expected) => {
    expect(normalizeHostedRedirectUrl(url)).toBe(expected);
  });

  test.each(['', 'invalid url', 'javascript:alert(1)', 'file:///tmp/invite', 'http://portal.example.com/callback'])('rejects invalid or insecure redirect %s', (url) => {
    expect(normalizeHostedRedirectUrl(url)).toBe('');
  });
});
