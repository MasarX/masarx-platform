const {
  normalizeEnvironmentName,
  normalizePolicy,
  evaluateAuthEmailUrlConfig,
} = require('../../../scripts/ops/auth/auth-email-url-policy');

describe('auth-email-url policy helpers', () => {
  test('normalizeEnvironmentName supports deploy aliases', () => {
    expect(normalizeEnvironmentName('dev')).toBe('dev');
    expect(normalizeEnvironmentName('db-stg')).toBe('stg');
    expect(normalizeEnvironmentName('db-prod')).toBe('prod');
  });

  test('normalizePolicy validates required fields', () => {
    const normalized = normalizePolicy(
      {
        environment: 'stg',
        site_url: '',
        additional_redirect_urls: [],
        banned_redirect_hosts: [],
      },
      'stg',
    );

    expect(normalized.issues).toEqual(
      expect.arrayContaining([
        'Policy site_url must be a valid http/https URL.',
        'Policy additional_redirect_urls must include at least one URL.',
        'Policy banned_redirect_hosts must include localhost bans.',
      ]),
    );
  });

  test('evaluateAuthEmailUrlConfig passes for matching hosted config', () => {
    const result = evaluateAuthEmailUrlConfig({
      policy: {
        environment: 'prod',
        site_url: 'https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback',
        additional_redirect_urls: [
          'https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback',
          'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/auth/callback',
        ],
        banned_redirect_hosts: ['localhost', '127.0.0.1', '.local', '.localhost'],
      },
      actual: {
        site_url: 'https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback',
        additional_redirect_urls: [
          'https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback',
          'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/auth/callback',
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('evaluateAuthEmailUrlConfig fails on localhost drift and missing required redirect', () => {
    const result = evaluateAuthEmailUrlConfig({
      policy: {
        environment: 'dev',
        site_url: 'https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback',
        additional_redirect_urls: [
          'https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback',
          'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
        ],
        banned_redirect_hosts: ['localhost', '127.0.0.1', '.local', '.localhost'],
      },
      actual: {
        site_url: 'http://localhost:3000/auth/callback',
        additional_redirect_urls: ['https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback'],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes('banned'))).toBe(true);
    expect(
      result.issues.some((issue) =>
        issue.includes('Missing required auth redirect URL: https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback')
      ),
    ).toBe(true);
  });

  test('evaluateAuthEmailUrlConfig detects policy environment mismatch', () => {
    const result = evaluateAuthEmailUrlConfig({
      policy: {
        environment: 'prod',
        site_url: 'https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback',
        additional_redirect_urls: ['https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback'],
        banned_redirect_hosts: ['localhost'],
      },
      actual: {
        site_url: 'https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback',
        additional_redirect_urls: ['https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback'],
      },
      expectedEnvironment: 'stg',
    });

    expect(result.ok).toBe(false);
    expect(
      result.issues.some((issue) =>
        issue.includes('Policy environment "prod" does not match target "stg".')
      ),
    ).toBe(true);
  });

  test('evaluateAuthEmailUrlConfig parses uppercase JSON-string redirect lists', () => {
    const result = evaluateAuthEmailUrlConfig({
      policy: {
        environment: 'stg',
        site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
        additional_redirect_urls: [
          'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
          'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
        ],
        banned_redirect_hosts: ['localhost', '127.0.0.1', '.local', '.localhost'],
      },
      actual: {
        SITE_URL: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
        URI_ALLOW_LIST: JSON.stringify([
          'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
          'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
        ]),
      },
      expectedEnvironment: 'stg',
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('evaluateAuthEmailUrlConfig parses newline-delimited redirects', () => {
    const result = evaluateAuthEmailUrlConfig({
      policy: {
        environment: 'stg',
        site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
        additional_redirect_urls: [
          'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
          'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
        ],
        banned_redirect_hosts: ['localhost', '127.0.0.1', '.local', '.localhost'],
      },
      actual: {
        site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
        uri_allow_list: [
          'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback\nhttps://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
        ],
      },
      expectedEnvironment: 'stg',
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
