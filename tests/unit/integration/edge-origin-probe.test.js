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
      allowlistValues: ['https://*.nzxmhryhtqlzoshjkyozkpup.example.invalid'],
      canonicalHosts: ['https://hguxuguuvhxjwymmxhlmkwwp.example.invalid', 'https://grtgggvjriwqrxhykymmloov.example.invalid', 'https://nzxmhryhtqlzoshjkyozkpup.example.invalid'],
      envValues: [],
    });
    expect(candidates).toEqual(['https://hguxuguuvhxjwymmxhlmkwwp.example.invalid', 'https://grtgggvjriwqrxhykymmloov.example.invalid', 'https://nzxmhryhtqlzoshjkyozkpup.example.invalid']);
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
