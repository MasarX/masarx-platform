const { buildAuthConfigPayloadVariants } = require('../../../scripts/ops/workspace/supabase-api');

describe('supabase-api auth config payload variants', () => {
  test('builds root and nested payloads for array and CSV redirect formats', () => {
    const siteUrl = 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback';
    const redirects = [
      'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
      'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
    ];
    const csv = redirects.join(',');

    const payloads = buildAuthConfigPayloadVariants({
      siteUrl,
      redirectUrls: redirects,
    });

    expect(payloads).toEqual(
      expect.arrayContaining([
        { site_url: siteUrl, additional_redirect_urls: redirects },
        { site_url: siteUrl, uri_allow_list: redirects },
        { site_url: siteUrl, redirect_urls: redirects },
        { site_url: siteUrl, additional_redirect_urls: csv },
        { site_url: siteUrl, uri_allow_list: csv },
        { site_url: siteUrl, redirect_urls: csv },
        { SITE_URL: siteUrl, URI_ALLOW_LIST: redirects },
        { SITE_URL: siteUrl, URI_ALLOW_LIST: csv },
        { auth: { site_url: siteUrl, additional_redirect_urls: redirects } },
        { auth: { site_url: siteUrl, uri_allow_list: redirects } },
        { auth: { site_url: siteUrl, redirect_urls: redirects } },
        { auth: { site_url: siteUrl, additional_redirect_urls: csv } },
        { auth: { site_url: siteUrl, uri_allow_list: csv } },
        { auth: { site_url: siteUrl, redirect_urls: csv } },
        { auth: { SITE_URL: siteUrl, URI_ALLOW_LIST: redirects } },
        { auth: { SITE_URL: siteUrl, URI_ALLOW_LIST: csv } },
      ]),
    );
  });

  test('deduplicates payload variants for duplicate redirect inputs', () => {
    const payloads = buildAuthConfigPayloadVariants({
      siteUrl: 'https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback',
      redirectUrls: [
        'https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback',
        'https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback',
      ],
    });

    const uniqueCount = new Set(payloads.map((payload) => JSON.stringify(payload))).size;
    expect(uniqueCount).toBe(payloads.length);
  });
});
