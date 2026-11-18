const {
  buildAllowedOriginCandidates,
  parseOriginTokens,
  probeAllowedOrigin,
} = require('../../integration/helpers/edge-origin-probe');

describe('edge-origin-probe helper', () => {
  test('parseOriginTokens supports CSV, newlines, and JSON arrays', () => {
    expect(parseOriginTokens('https://a.test, https://b.test')).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
    expect(parseOriginTokens('https://a.test\nhttps://b.test')).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
    expect(parseOriginTokens('["https://a.test","https://b.test"]')).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
  });

  test('buildAllowedOriginCandidates expands wildcard entries against canonical hosts', () => {
    const candidates = buildAllowedOriginCandidates({
      allowlistValues: ['https://*.synthetic.example.invalid'],
      canonicalHosts: ['https://console.synthetic.example.invalid', 'https://portal.synthetic.example.invalid', 'https://synthetic.example.invalid'],
      envValues: [],
    });
    expect(candidates).toEqual(['https://console.synthetic.example.invalid', 'https://portal.synthetic.example.invalid', 'https://synthetic.example.invalid']);
  });

  test.each([0, 302, 401, 404, 429, 500, 502, 503])('status %s cannot admit an origin', async status => {
    const result = await probeAllowedOrigin(['https://a.test'], async () => ({
      status, body: { error: { code: 'server_misconfigured' } },
    }));
    expect(result.origin).toBe('');
    expect(result.attempts).toEqual([{ origin: 'https://a.test', status, code: 'server_misconfigured' }]);
  });
  test('configuration failure remains rejected even with a client status', async () => {
    const result = await probeAllowedOrigin(['https://a.test'], async () => ({
      status: 400, body: { error: { code: 'server_misconfigured' } },
    }));
    expect(result.origin).toBe('');
  });

  test('probeAllowedOrigin skips all 403 responses and returns first acceptable origin', async () => {
    const candidates = ['https://a.test', 'https://b.test', 'https://c.test'];
    const calls = [];
    const result = await probeAllowedOrigin(candidates, async (origin) => {
      calls.push(origin);
      if (origin === 'https://a.test') {
        return { status: 403, body: { error: { code: 'origin_not_allowed' } } };
      }
      if (origin === 'https://b.test') {
        return { status: 403, body: { error: { code: 'origin_required' } } };
      }
      return { status: 400, body: { error: { code: 'turnstile_required' } } };
    });

    expect(result.origin).toBe('https://c.test');
    expect(calls).toEqual(['https://a.test', 'https://b.test', 'https://c.test']);
  });
});
