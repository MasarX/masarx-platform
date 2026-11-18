describe('workspace/supabase-api', () => {
  const originalPreferModern = process.env.SUPABASE_PREFER_MANAGEMENT_API_KEYS;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    if (originalPreferModern == null) {
      delete process.env.SUPABASE_PREFER_MANAGEMENT_API_KEYS;
    } else {
      process.env.SUPABASE_PREFER_MANAGEMENT_API_KEYS = originalPreferModern;
    }
  });

  test('listProjects returns array response as-is', async () => {
    const { listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify([{
        ref: 'abcdefghijklmnopqrst',
        name: 'a',
        organization_id: 'org',
        organization_slug: 'org-slug',
      }]),
    });
    await expect(listProjects({ token: 't', organizationId: 'org' })).resolves.toEqual([expect.objectContaining({ name: 'a' })]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/projects$/),
      expect.objectContaining({ method: 'GET' })
    );
  });

  test('listProjects unwraps {projects: []} responses', async () => {
    jest.resetModules();
    const { listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ projects: [{
        ref: 'abcdefghijklmnopqrst',
        name: 'b',
        organization_id: 'org',
      }] }),
    });
    await expect(listProjects({ token: 't', organizationId: 'org' })).resolves.toEqual([
      expect.objectContaining({ name: 'b' }),
    ]);
  });

  test('listProjects throws when missing token/org', async () => {
    jest.resetModules();
    const { listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    await expect(listProjects({ token: '', organizationId: 'org' })).rejects.toThrow(/SUPABASE_ACCESS_TOKEN/i);
    await expect(listProjects({ token: 't', organizationId: '' })).rejects.toThrow(/SUPABASE_ORG_ID/i);
  });

  test('listProjects fails closed on malformed responses when verifiable absence is required', async () => {
    jest.resetModules();
    const { listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ unexpected: [] }),
    });
    await expect(listProjects({
      token: 't',
      organizationId: 'org',
      requireVerifiableResponse: true,
    })).rejects.toThrow(/not verifiable.*top-level project array/i);
  });

  test('listProjects rejects wrapped or partial responses when verifiable absence is required', async () => {
    jest.resetModules();
    const { listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({
        projects: [{
          ref: 'abcdefghijklmnopqrst',
          organization_id: 'org',
        }],
        total: 2,
      }),
    });
    await expect(listProjects({
      token: 't',
      organizationId: 'org',
      requireVerifiableResponse: true,
    })).rejects.toThrow(/not verifiable.*top-level project array/i);
  });

  test('listProjects rejects malformed rows when verifiable absence is required', async () => {
    jest.resetModules();
    const { listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify([{ organization_id: 'org' }]),
    });
    await expect(listProjects({
      token: 't',
      organizationId: 'org',
      requireVerifiableResponse: true,
    })).rejects.toThrow(/row 0 lacks a canonical 20-letter immutable project ref/i);
  });

  test('listProjects rejects duplicate immutable refs when verifiable absence is required', async () => {
    jest.resetModules();
    const { listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify([
        { ref: 'abcdefghijklmnopqrst', organization_id: 'org-a' },
        { ref: 'abcdefghijklmnopqrst', organization_id: 'org-b' },
      ]),
    });
    await expect(listProjects({
      token: 't',
      organizationId: 'org-a',
      requireVerifiableResponse: true,
    })).rejects.toThrow(/duplicates immutable project ref abcdefghijklmnopqrst/i);
  });

  test('listProjects accepts mixed organizations for complete-list absence proof', async () => {
    jest.resetModules();
    const { listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify([
        {
          ref: 'abcdefghijklmnopqrst',
          organization_id: 'different-org',
        },
        {
          ref: 'bcdefghijklmnopqrstu',
          organization_slug: 'org',
        },
      ]),
    });
    await expect(listProjects({
      token: 't',
      organizationId: 'org',
      requireVerifiableResponse: true,
    })).resolves.toHaveLength(2);
  });

  test('listProjects filters the documented global array by exact organization for discovery', async () => {
    jest.resetModules();
    const { listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify([
        {
          ref: 'abcdefghijklmnopqrst',
          organization_id: 'different-org',
        },
        {
          ref: 'bcdefghijklmnopqrstu',
          organization_slug: 'org',
        },
      ]),
    });
    await expect(listProjects({ token: 't', organizationId: 'org' })).resolves.toEqual([
      expect.objectContaining({ ref: 'bcdefghijklmnopqrstu' }),
    ]);
  });

  test('project management reads and deletes accept optional request deadlines', async () => {
    jest.resetModules();
    const { deleteProject, getProject, listProjects } = require('../../../scripts/ops/workspace/supabase-api');
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue('bounded-signal');
    global.fetch
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => '{}' })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => '{}' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([{
          ref: 'abcdefghijklmnopqrst',
          organization_id: 'org',
          organization_slug: 'org-slug',
        }]),
      });
    try {
      await getProject('abcdefghijklmnopqrst', 't', { timeoutMs: 111 });
      await deleteProject('abcdefghijklmnopqrst', 't', { timeoutMs: 222 });
      await listProjects({
        token: 't',
        organizationId: 'org',
        requireVerifiableResponse: true,
        timeoutMs: 333,
      });
      expect(timeoutSpy).toHaveBeenNthCalledWith(1, 111);
      expect(timeoutSpy).toHaveBeenNthCalledWith(2, 222);
      expect(timeoutSpy).toHaveBeenNthCalledWith(3, 333);
      expect(global.fetch.mock.calls.map((call) => call[1].signal)).toEqual([
        'bounded-signal',
        'bounded-signal',
        'bounded-signal',
      ]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test('authConfigContainsRequiredRedirects validates required redirects against readback payload', () => {
    jest.resetModules();
    const { authConfigContainsRequiredRedirects } = require('../../../scripts/ops/workspace/supabase-api');

    const expected = {
      siteUrl: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
      redirectUrls: [
        'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
        'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
      ],
    };

    expect(
      authConfigContainsRequiredRedirects(
        {
          site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
          additional_redirect_urls: [
            'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
            'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
            'https://nvzpwzpvpxgtwgywslioypqv.example.invalid/auth/callback',
          ],
        },
        expected,
      ),
    ).toBe(true);

    expect(
      authConfigContainsRequiredRedirects(
        {
          site_url: 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
          additional_redirect_urls: ['https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback'],
        },
        expected,
      ),
    ).toBe(false);
  });

  test('setProjectAuthConfig keeps trying payload variants until readback contains required redirects', async () => {
    jest.resetModules();
    const { setProjectAuthConfig } = require('../../../scripts/ops/workspace/supabase-api');
    const siteUrl = 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback';
    const redirects = [
      'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
      'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
    ];

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ site_url: siteUrl, additional_redirect_urls: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            site_url: siteUrl,
            additional_redirect_urls: redirects,
          }),
      });

    await expect(
      setProjectAuthConfig('ref', 'token', {
        site_url: siteUrl,
        additional_redirect_urls: redirects,
        verify_attempts: 1,
      }),
    ).resolves.toMatchObject({
      site_url: siteUrl,
      additional_redirect_urls: redirects,
    });

    expect(global.fetch).toHaveBeenCalledTimes(4);
    const writeCalls = global.fetch.mock.calls.filter(
      (call) => String(call?.[1]?.method || '').toUpperCase() !== 'GET',
    );
    expect(writeCalls).toHaveLength(2);
    expect(writeCalls[0][1]).toEqual(expect.objectContaining({ method: 'PATCH' }));
    expect(String(writeCalls[0][0])).toContain('/v1/projects/ref/config/auth');
  });

  test('assertOrganizationAccess succeeds when projects endpoint is readable', async () => {
    jest.resetModules();
    const { assertOrganizationAccess } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify([]),
    });
    await expect(assertOrganizationAccess({ token: 't', organizationId: 'org' })).resolves.toEqual({
      ok: true,
    });
  });

  test('assertOrganizationAccess fails with actionable message for org/token mismatch', async () => {
    jest.resetModules();
    const { assertOrganizationAccess } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ message: 'Organization not found' }),
    });
    await expect(assertOrganizationAccess({ token: 't', organizationId: 'org-missing' })).rejects.toThrow(
      /organization access preflight failed.*Organization not found/i,
    );
  });

  test('evaluateAuthConfigWriteState supports uppercase management API fields', () => {
    jest.resetModules();
    const { evaluateAuthConfigWriteState } = require('../../../scripts/ops/workspace/supabase-api');
    const siteUrl = 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback';
    const redirects = [
      'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
      'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
    ];
    const out = evaluateAuthConfigWriteState({
      siteUrl,
      redirectUrls: redirects,
      actual: {
        SITE_URL: siteUrl,
        URI_ALLOW_LIST: redirects,
      },
    });
    expect(out.ok).toBe(true);
    expect(out.missingRedirects).toEqual([]);
  });

  test('evaluateAuthConfigWriteState parses JSON-string and newline redirect formats', () => {
    jest.resetModules();
    const { evaluateAuthConfigWriteState } = require('../../../scripts/ops/workspace/supabase-api');
    const siteUrl = 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback';
    const redirects = [
      'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
      'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
    ];
    const out = evaluateAuthConfigWriteState({
      siteUrl,
      redirectUrls: redirects,
      actual: {
        site_url: siteUrl,
        uri_allow_list: JSON.stringify([
          'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback\nhttps://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
        ]),
      },
    });
    expect(out.ok).toBe(true);
    expect(out.missingRedirects).toEqual([]);
  });

  test('setProjectAuthConfig continues when a write returns 200 but does not apply config', async () => {
    jest.resetModules();
    const { setProjectAuthConfig } = require('../../../scripts/ops/workspace/supabase-api');
    const expectedSite = 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback';
    const expectedRedirects = [
      'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
      'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
    ];
    let state = {
      site_url: 'https://legacy.example.com/auth/callback',
      additional_redirect_urls: ['https://legacy.example.com/auth/callback'],
    };
    const okResponse = (body) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
    });
    global.fetch.mockImplementation(async (url, options = {}) => {
      const method = String(options?.method || 'GET').toUpperCase();
      const body = options?.body ? JSON.parse(options.body) : {};
      if (method === 'GET') {
        return okResponse(state);
      }
      // Simulate management API shape drift: only one payload variant actually persists.
      if (
        body?.config?.auth?.site_url === expectedSite &&
        Array.isArray(body?.config?.auth?.additional_redirect_urls)
      ) {
        state = {
          site_url: body.config.auth.site_url,
          additional_redirect_urls: body.config.auth.additional_redirect_urls,
        };
      }
      return okResponse({ applied: true });
    });

    await expect(
      setProjectAuthConfig('proj-ref', 'token', {
        site_url: expectedSite,
        additional_redirect_urls: expectedRedirects,
        verify_attempts: 1,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        source: expect.stringMatching(/(PATCH|PUT) \/v1\/projects\/proj-ref\/(config\/auth|settings)/),
      }),
    );

    expect(state.site_url).toBe(expectedSite);
    expect(state.additional_redirect_urls).toEqual(expectedRedirects);
    const writeCalls = global.fetch.mock.calls.filter(
      (call) => String(call?.[1]?.method || '').toUpperCase() !== 'GET',
    );
    expect(writeCalls.length).toBeGreaterThan(1);
  });

  test('setProjectAuthConfig fails closed when writes never apply expected auth config', async () => {
    jest.resetModules();
    const { setProjectAuthConfig } = require('../../../scripts/ops/workspace/supabase-api');
    const expectedSite = 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback';
    const expectedRedirects = [
      'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
      'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
    ];
    const okResponse = (body) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
    });
    global.fetch.mockImplementation(async (url, options = {}) => {
      const method = String(options?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return okResponse({
          site_url: 'https://legacy.example.com/auth/callback',
          additional_redirect_urls: ['https://legacy.example.com/auth/callback'],
        });
      }
      return okResponse({ applied: true });
    });

    await expect(
      setProjectAuthConfig('proj-ref', 'token', {
        site_url: expectedSite,
        additional_redirect_urls: expectedRedirects,
        verify_attempts: 1,
      }),
    ).rejects.toThrow(/write accepted but verification mismatch/i);
  });

  test('extractPoolerHostsFromPayload returns distinct pooler hosts in encounter order', () => {
    jest.resetModules();
    const { extractPoolerHostsFromPayload } = require('../../../scripts/ops/workspace/supabase-api');

    expect(
      extractPoolerHostsFromPayload({
        database: {
          primary: 'aws-1-us-east-1.pooler.supabase.com',
          replicas: ['aws-0-us-east-1.pooler.supabase.com', 'aws-1-us-east-1.pooler.supabase.com'],
        },
      }),
    ).toEqual([
      'aws-1-us-east-1.pooler.supabase.com',
      'aws-0-us-east-1.pooler.supabase.com',
    ]);
  });

  test('resolveProjectPoolerHost prefers discovered host for requested region', async () => {
    jest.resetModules();
    const { resolveProjectPoolerHost } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          connection_pooling: {
            pooler_host: 'aws-0-us-east-1.pooler.supabase.com',
          },
        }),
    });

    await expect(
      resolveProjectPoolerHost({
        projectRef: 'ref',
        token: 'tok',
        preferredRegion: 'us-east-1',
      }),
    ).resolves.toBe('aws-0-us-east-1.pooler.supabase.com');
  });

  test('resolveProjectPoolerHost falls back to region-derived host when metadata endpoints are unavailable', async () => {
    jest.resetModules();
    const { resolveProjectPoolerHost } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ message: 'missing' }),
    });

    await expect(
      resolveProjectPoolerHost({
        projectRef: 'ref',
        token: 'tok',
        preferredRegion: 'us-east-1',
      }),
    ).resolves.toBe('aws-1-us-east-1.pooler.supabase.com');
  });

  test('resolveProjectPoolerHost derives from exact metadata region instead of a stale caller fallback', async () => {
    jest.resetModules();
    const { resolveProjectPoolerHost } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ region: 'eu-west-1' }),
      })
      .mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ message: 'missing' }),
      });

    await expect(resolveProjectPoolerHost({
      projectRef: 'abcdefghijklmnopqrst',
      token: 'tok',
      preferredRegion: 'me-central-1',
    })).resolves.toBe('aws-1-eu-west-1.pooler.supabase.com');
  });

  test('resolveProjectPoolerHost can forbid guessed hosts and return direct-DB fallback instead', async () => {
    jest.resetModules();
    const { resolveProjectPoolerHost } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ message: 'missing' }),
    });

    await expect(resolveProjectPoolerHost({
      projectRef: 'abcdefghijklmnopqrst',
      token: 'tok',
      preferredRegion: 'us-east-1',
      allowDerivedFallback: false,
    })).resolves.toBe('');
  });

  test('resolveProjectPoolerHost rejects noncanonical region and fallback host inputs', async () => {
    jest.resetModules();
    const { resolveProjectPoolerHost } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ message: 'missing' }),
    });

    await expect(resolveProjectPoolerHost({
      projectRef: 'abcdefghijklmnopqrst',
      token: 'tok',
      preferredRegion: 'me-central-1.attacker.example',
      fallbackHost: 'attacker.pooler.supabase.com',
    })).resolves.toBe('');
  });

  test('getApiKeys prefers legacy anon/service keys by default', async () => {
    process.env.SUPABASE_PREFER_MANAGEMENT_API_KEYS = '0';
    jest.resetModules();
    const { getApiKeys } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify([
          { name: 'anon', type: 'legacy', api_key: 'legacy-anon' },
          { name: 'service_role', type: 'legacy', api_key: 'legacy-service' },
          { name: 'default', type: 'publishable', api_key: 'sb_publishable_123' },
          { name: 'default', type: 'secret', api_key: 'sb_secret_123' },
        ]),
    });

    await expect(getApiKeys('ref', 'token')).resolves.toEqual(
      expect.objectContaining({
        anon: 'legacy-anon',
        service: 'legacy-service',
        publishable: 'sb_publishable_123',
        secret: 'sb_secret_123',
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/projects/ref/api-keys'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(String(global.fetch.mock.calls[0][0])).not.toContain('reveal=true');
  });

  test('getApiKeys prefers publishable/secret keys when preferModern=true', async () => {
    jest.resetModules();
    const { getApiKeys } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify([
          { name: 'anon', type: 'legacy', api_key: 'legacy-anon' },
          { name: 'service_role', type: 'legacy', api_key: 'legacy-service' },
          { name: 'default', type: 'publishable', api_key: 'sb_publishable_modern' },
          { name: 'default', type: 'secret', api_key: 'sb_secret_modern' },
        ]),
    });

    await expect(getApiKeys('ref', 'token', { preferModern: true })).resolves.toEqual(
      expect.objectContaining({
        anon: 'sb_publishable_modern',
        service: 'sb_secret_modern',
        legacyAnon: 'legacy-anon',
        legacyService: 'legacy-service',
      }),
    );
    expect(String(global.fetch.mock.calls[0][0])).toContain('/v1/projects/ref/api-keys?reveal=true');
  });

  test('getApiKeys retries with reveal=true when default response is masked', async () => {
    process.env.SUPABASE_PREFER_MANAGEMENT_API_KEYS = '0';
    jest.resetModules();
    const { getApiKeys } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify([
            { name: 'anon', type: 'legacy', api_key: '********' },
            { name: 'service_role', type: 'legacy', api_key: '********' },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify([
            { name: 'anon', type: 'legacy', api_key: 'legacy-anon-reveal' },
            { name: 'service_role', type: 'legacy', api_key: 'legacy-service-reveal' },
          ]),
      });

    await expect(getApiKeys('ref', 'token')).resolves.toEqual(
      expect.objectContaining({
        anon: 'legacy-anon-reveal',
        service: 'legacy-service-reveal',
        legacyAnon: 'legacy-anon-reveal',
        legacyService: 'legacy-service-reveal',
      }),
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String(global.fetch.mock.calls[0][0])).not.toContain('reveal=true');
    expect(String(global.fetch.mock.calls[1][0])).toContain('reveal=true');
  });

  test('deleteProjectWithRetries retries when project not ready', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ message: 'Project not ready for deletion.' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({}),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ message: 'not found' }),
      });
    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 't', {
      organizationId: 'exact-org-id', timeoutMs: 1000, intervalMs: 0,
    })).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('deleteProjectWithRetries treats 404 as success', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ message: 'not found' }),
    });
    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 't', {
      organizationId: 'exact-org-id', timeoutMs: 1000, intervalMs: 0,
    })).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('deleteProjectWithRetries treats provider removed tombstones as success', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ message: 'Resource has been removed' }),
    });
    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 't', {
      organizationId: 'exact-org-id', timeoutMs: 1000, intervalMs: 0,
    })).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('deleteProjectWithRetries waits for provider absence after DELETE is accepted', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn().mockResolvedValue(undefined);
    const getProjectFn = jest.fn()
      .mockResolvedValueOnce({ status: 'ACTIVE_HEALTHY' })
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));
    let now = 0;

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 't', {
      organizationId: 'exact-org-id',
      timeoutMs: 1000,
      intervalMs: 10,
      deleteProjectFn,
      getProjectFn,
      nowFn: () => now,
      sleepFn: async (ms) => { now += ms; },
    })).resolves.toBeUndefined();
    expect(deleteProjectFn).toHaveBeenCalledTimes(1);
    expect(getProjectFn).toHaveBeenCalledTimes(2);
  });

  test('deleteProjectWithRetries accepts post-delete 403 only when same-token complete listing proves ref absent globally', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn().mockResolvedValue(undefined);
    const getProjectFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('insufficient privileges'), { status: 403 }),
    );
    const listProjectsFn = jest.fn().mockResolvedValue([
      { ref: 'bcdefghijklmnopqrstu', name: 'wk-other', organization_id: 'other-org-id' },
      { ref: 'cdefghijklmnopqrstuv', name: 'wk-sibling', organization_id: 'exact-org-id' },
    ]);

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      organizationId: 'exact-org-id',
      timeoutMs: 1000,
      intervalMs: 10,
      deleteProjectFn,
      getProjectFn,
      listProjectsFn,
    })).resolves.toBeUndefined();

    expect(deleteProjectFn).toHaveBeenCalledWith(
      'abcdefghijklmnopqrst',
      'EXAMPLE_PASSWORD',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(listProjectsFn).toHaveBeenCalledWith(expect.objectContaining({
      token: 'EXAMPLE_PASSWORD',
      organizationId: 'exact-org-id',
      requireVerifiableResponse: true,
      timeoutMs: expect.any(Number),
    }));
  });

  test('deleteProjectWithRetries uses the documented complete project list after an accepted DELETE', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ ref: 'abcdefghijklmnopqrst' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: () => '' },
        text: async () => JSON.stringify({ message: 'insufficient privileges' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([
          {
            ref: 'bcdefghijklmnopqrstu',
            organization_id: 'other-org-id',
          },
          {
            ref: 'cdefghijklmnopqrstuv',
            organization_slug: 'exact-org-slug',
          },
        ]),
      });

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      organizationId: 'exact-org-id',
      timeoutMs: 1000,
      intervalMs: 10,
    })).resolves.toBeUndefined();

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/v1\/projects\/abcdefghijklmnopqrst$/);
    expect(global.fetch.mock.calls[1][0]).toMatch(/\/v1\/projects\/abcdefghijklmnopqrst$/);
    expect(global.fetch.mock.calls[2][0]).toMatch(/\/v1\/projects$/);
    expect(global.fetch.mock.calls[2][0]).not.toContain('organization_id');
  });

  test('deleteProjectWithRetries keeps polling when post-delete 403 listing retains the immutable ref', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn().mockResolvedValue(undefined);
    const getProjectFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('insufficient privileges'), { status: 403 }),
    );
    const listProjectsFn = jest.fn()
      .mockResolvedValueOnce([{
        project_ref: 'abcdefghijklmnopqrst',
        organization_id: 'different-org-id',
      }])
      .mockResolvedValueOnce([]);
    let now = 0;

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      organizationId: 'exact-org-id',
      timeoutMs: 1000,
      intervalMs: 10,
      deleteProjectFn,
      getProjectFn,
      listProjectsFn,
      nowFn: () => now,
      sleepFn: async (ms) => { now += ms; },
    })).resolves.toBeUndefined();

    expect(deleteProjectFn).toHaveBeenCalledTimes(1);
    expect(getProjectFn).toHaveBeenCalledTimes(2);
    expect(listProjectsFn).toHaveBeenCalledTimes(2);
  });

  test('deleteProjectWithRetries times out fail-closed while post-delete 403 listing retains the immutable ref', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn().mockResolvedValue(undefined);
    const getProjectFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('insufficient privileges'), { status: 403 }),
    );
    const listProjectsFn = jest.fn().mockResolvedValue([
      { id: 'abcdefghijklmnopqrst', organization_id: 'exact-org-id' },
    ]);
    let now = 0;

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      organizationId: 'exact-org-id',
      timeoutMs: 20,
      intervalMs: 10,
      deleteProjectFn,
      getProjectFn,
      listProjectsFn,
      nowFn: () => now,
      sleepFn: async (ms) => { now += ms; },
    })).rejects.toThrow(/Timeout confirming project abcdefghijklmnopqrst deletion/i);

    expect(deleteProjectFn).toHaveBeenCalledTimes(1);
    expect(listProjectsFn).toHaveBeenCalledTimes(2);
  });

  test('deleteProjectWithRetries rejects missing organization identity before DELETE', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn().mockResolvedValue(undefined);
    const getProjectFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('insufficient privileges'), { status: 403 }),
    );
    const listProjectsFn = jest.fn();

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      timeoutMs: 1000,
      intervalMs: 10,
      deleteProjectFn,
      getProjectFn,
      listProjectsFn,
    })).rejects.toThrow(/organizationId is required for same-token deletion proof/i);

    expect(deleteProjectFn).not.toHaveBeenCalled();
    expect(getProjectFn).not.toHaveBeenCalled();
    expect(listProjectsFn).not.toHaveBeenCalled();
  });

  test('deleteProjectWithRetries rejects a noncanonical ref before DELETE', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn();
    await expect(deleteProjectWithRetries('not-a-af38b526-f5c1-468d-88fb-86677fbe872a', 'EXAMPLE_PASSWORD', {
      organizationId: 'exact-org-id',
      deleteProjectFn,
    })).rejects.toThrow(/canonical 20-letter immutable Supabase project ref/i);
    expect(deleteProjectFn).not.toHaveBeenCalled();
  });

  test('deleteProjectWithRetries fails closed when post-delete 403 organization visibility is unavailable', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn().mockResolvedValue(undefined);
    const getProjectFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('insufficient privileges'), { status: 403 }),
    );
    const listProjectsFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('organization forbidden'), { status: 403 }),
    );

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      organizationId: 'exact-org-id',
      timeoutMs: 1000,
      intervalMs: 10,
      deleteProjectFn,
      getProjectFn,
      listProjectsFn,
    })).rejects.toThrow(/complete same-token project visibility is unavailable or unverifiable/i);
  });

  test('deleteProjectWithRetries fails closed on DELETE-time 403 without organization fallback', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('delete forbidden'), { status: 403 }),
    );
    const getProjectFn = jest.fn();
    const listProjectsFn = jest.fn();

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      organizationId: 'exact-org-id',
      timeoutMs: 1000,
      intervalMs: 10,
      deleteProjectFn,
      getProjectFn,
      listProjectsFn,
    })).rejects.toThrow(/delete forbidden/i);

    expect(getProjectFn).not.toHaveBeenCalled();
    expect(listProjectsFn).not.toHaveBeenCalled();
  });

  test('deleteProjectWithRetries retries transient organization-list failures and preserves identity', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn().mockResolvedValue(undefined);
    const getProjectFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('insufficient privileges'), { status: 403 }),
    );
    const listProjectsFn = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('temporarily unavailable'), { status: 503 }))
      .mockResolvedValueOnce([]);
    let now = 0;

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      organizationId: 'exact-org-id',
      timeoutMs: 1000,
      intervalMs: 10,
      deleteProjectFn,
      getProjectFn,
      listProjectsFn,
      nowFn: () => now,
      sleepFn: async (ms) => { now += ms; },
    })).resolves.toBeUndefined();

    expect(deleteProjectFn).toHaveBeenCalledTimes(1);
    expect(getProjectFn).toHaveBeenCalledTimes(2);
    expect(listProjectsFn).toHaveBeenCalledTimes(2);
    expect(listProjectsFn.mock.calls[0][0]).toEqual(expect.objectContaining({
      token: 'EXAMPLE_PASSWORD',
      organizationId: 'exact-org-id',
      requireVerifiableResponse: true,
      timeoutMs: 1000,
    }));
    expect(listProjectsFn.mock.calls[1][0].timeoutMs).toBe(990);
  });

  test('deleteProjectWithRetries caps Retry-After at the remaining deadline and fails closed', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    const deleteProjectFn = jest.fn().mockResolvedValue(undefined);
    const getProjectFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('insufficient privileges'), { status: 403 }),
    );
    const listProjectsFn = jest.fn().mockRejectedValue(
      Object.assign(new Error('rate limited'), { status: 429, retryAfter: '2' }),
    );
    const sleeps = [];
    let now = 0;

    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 'EXAMPLE_PASSWORD', {
      organizationId: 'exact-org-id',
      timeoutMs: 20,
      intervalMs: 10,
      deleteProjectFn,
      getProjectFn,
      listProjectsFn,
      nowFn: () => now,
      sleepFn: async (ms) => { sleeps.push(ms); now += ms; },
    })).rejects.toThrow(/Timeout confirming project abcdefghijklmnopqrst deletion/i);

    expect(listProjectsFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([20]);
  });

  test('deleteProjectWithRetries throws on non-retryable delete errors', async () => {
    jest.resetModules();
    const { deleteProjectWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ message: 'unauthorized' }),
    });
    await expect(deleteProjectWithRetries('abcdefghijklmnopqrst', 't', {
      organizationId: 'exact-org-id', timeoutMs: 1000, intervalMs: 0,
    })).rejects.toThrow(/HTTP 401/i);
  });

  test('getProjectJwtSecret returns jwt_secret from settings', async () => {
    jest.resetModules();
    const { getProjectJwtSecret } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ jwt_secret: 'secret' }),
    });
    await expect(getProjectJwtSecret('ref', 'token')).resolves.toBe('secret');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/projects/ref/settings'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  test('getProjectJwtSecret ignores masked values', async () => {
    jest.resetModules();
    const { getProjectJwtSecret } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ jwt_secret: '********' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ jwt: { secret: 'real-secret' } }),
      });
    await expect(getProjectJwtSecret('ref', 'token')).resolves.toBe('real-secret');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('getProjectJwtSecret falls back across endpoints', async () => {
    jest.resetModules();
    const { getProjectJwtSecret } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ message: 'not found' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ jwt: { secret: 'nested' } }),
      });
    await expect(getProjectJwtSecret('ref', 'token')).resolves.toBe('nested');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('setProjectJwtSecret prefers settings when available (and also attempts config/auth)', async () => {
    jest.resetModules();
    const { setProjectJwtSecret } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ name: 'proj' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({}),
      });
    await expect(setProjectJwtSecret('ref', 'token', 'secret')).resolves.toMatchObject({
      method: 'PATCH',
      path: '/v1/projects/ref/settings',
    });
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/v1/projects/ref/settings'),
      expect.objectContaining({ method: 'PATCH' })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('/v1/projects/ref/config/auth'),
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  test('setProjectJwtSecret falls back to config/auth when settings is missing', async () => {
    jest.resetModules();
    const { setProjectJwtSecret } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ name: 'proj' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ message: 'missing' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ message: 'missing' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({}),
      });
    await expect(setProjectJwtSecret('ref', 'token', 'secret')).resolves.toMatchObject({
      path: '/v1/projects/ref/config/auth',
    });
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  test('setProjectDatabasePassword uses PATCH database/password endpoint', async () => {
    jest.resetModules();
    const { setProjectDatabasePassword } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({}),
    });

    await expect(
      setProjectDatabasePassword({ projectRef: 'ref', token: 'token', password: 'secret-pass' }),
    ).resolves.toMatchObject({
      method: 'PATCH',
      path: '/v1/projects/ref/database/password',
      body: { password: 'secret-pass' },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/projects/ref/database/password'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  test('setProjectDatabasePassword retries the official endpoint while project DB readiness is still converging', async () => {
    jest.resetModules();
    const { setProjectDatabasePassword } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ message: 'Failed to update password: Connection terminated unexpectedly' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({}),
      });

    await expect(
      setProjectDatabasePassword({
        projectRef: 'ref',
        token: 'token',
        password: 'secret-pass',
        maxWaitMs: 1000,
        retryDelayMs: 1,
      }),
    ).resolves.toMatchObject({
      method: 'PATCH',
      path: '/v1/projects/ref/database/password',
      body: { password: 'secret-pass' },
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/v1/projects/ref/database/password'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  test('ensureProjectJwtSecret returns explicit secret', async () => {
    jest.resetModules();
    const { ensureProjectJwtSecret } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ name: 'proj' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({}),
      });
    const res = await ensureProjectJwtSecret({ projectRef: 'ref', token: 'token', explicitSecret: 'secret' });
    expect(res).toMatchObject({ secret: 'secret', source: 'explicit' });
  });

  test('findBranchByName falls back to list when direct endpoint is unavailable', async () => {
    jest.resetModules();
    const { findBranchByName } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ message: 'missing' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([
          { id: 'branch-1', branch_name: 'wk-repo-pr-123', project_ref: 'proj-123' },
        ]),
      });

    await expect(findBranchByName({
      token: 'tok',
      parentProjectRef: 'parent-ref',
      name: 'wk-repo-pr-123',
    })).resolves.toEqual(expect.objectContaining({
      branch_id: 'branch-1',
      project_ref: 'proj-123',
      name: 'wk-repo-pr-123',
    }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('ensureBranch reuses an exact pre-existing branch before POST', async () => {
    jest.resetModules();
    const { ensureBranch } = require('../../../scripts/ops/workspace/supabase-api');
    const findBranchByNameFn = jest.fn().mockResolvedValue({
      branch_id: 'branch-1',
      name: 'wk-repo-pr-123',
      project_ref: 'proj-123',
    });

    await expect(ensureBranch({
      token: 'tok',
      parentProjectRef: 'parent-ref',
      name: 'wk-repo-pr-123',
      reuseExisting: true,
      findBranchByNameFn,
    })).resolves.toEqual(expect.objectContaining({
      branch_id: 'branch-1',
      project_ref: 'proj-123',
      reused: true,
    }));
    expect(findBranchByNameFn).toHaveBeenCalledTimes(1);
    expect(findBranchByNameFn).toHaveBeenCalledWith({
      token: 'tok',
      parentProjectRef: 'parent-ref',
      name: 'wk-repo-pr-123',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('ensureBranch reconciles every generic 409 by exact name and sends only the official create body', async () => {
    jest.resetModules();
    const { ensureBranch } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () => JSON.stringify({ message: 'Failed to provision branch project' }),
    });
    const findBranchByNameFn = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        branch_id: 'branch-race-winner',
        name: 'wk-repo-pr-123',
        project_ref: 'abcdefghijklmnopqrst',
      });

    await expect(ensureBranch({
      token: 'tok',
      parentProjectRef: 'uvwxyzabcdefghijklmn',
      name: 'wk-repo-pr-123',
      reuseExisting: true,
      findBranchByNameFn,
      sleepFn: jest.fn(),
    })).resolves.toEqual(expect.objectContaining({
      branch_id: 'branch-race-winner',
      project_ref: 'abcdefghijklmnopqrst',
      reused: true,
    }));

    expect(findBranchByNameFn).toHaveBeenCalledTimes(2);
    expect(findBranchByNameFn).toHaveBeenNthCalledWith(1, {
      token: 'tok',
      parentProjectRef: 'uvwxyzabcdefghijklmn',
      name: 'wk-repo-pr-123',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects/uvwxyzabcdefghijklmn/branches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ branch_name: 'wk-repo-pr-123' }),
      }),
    );
  });

  test('ensureBranch reconciles an inconclusive create response by exact parent and name', async () => {
    jest.resetModules();
    const { ensureBranch } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockRejectedValueOnce(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
    const findBranchByNameFn = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        branch_id: 'branch-1',
        project_ref: 'abcdefghijklmnopqrst',
        name: 'wk-repo-pr-123',
      });

    await expect(ensureBranch({
      token: 'tok',
      parentProjectRef: 'uvwxyzabcdefghijklmn',
      name: 'wk-repo-pr-123',
      reuseExisting: true,
      findBranchByNameFn,
      sleepFn: jest.fn(),
    })).resolves.toEqual(expect.objectContaining({
      branch_id: 'branch-1',
      project_ref: 'abcdefghijklmnopqrst',
      reused: true,
    }));
    expect(findBranchByNameFn).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('ensureBranch pinned-existing mode returns only the exact pre-existing branch without mutation', async () => {
    jest.resetModules();
    const { ensureBranch } = require('../../../scripts/ops/workspace/supabase-api');
    const findBranchByNameFn = jest.fn().mockResolvedValue({
      branch_id: 'branch-1',
      project_ref: 'abcdefghijklmnopqrst',
      name: 'wk-repo-pr-123',
    });

    await expect(ensureBranch({
      token: 'tok',
      parentProjectRef: 'uvwxyzabcdefghijklmn',
      name: 'wk-repo-pr-123',
      requireExisting: true,
      expectedProjectRef: 'abcdefghijklmnopqrst',
      findBranchByNameFn,
    })).resolves.toEqual(expect.objectContaining({
      branch_id: 'branch-1',
      project_ref: 'abcdefghijklmnopqrst',
      reused: true,
    }));
    expect(findBranchByNameFn).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('ensureBranch refuses an expected identity unless no-create existing mode is enabled', async () => {
    jest.resetModules();
    const { ensureBranch } = require('../../../scripts/ops/workspace/supabase-api');

    const error = await ensureBranch({
      token: 'tok',
      parentProjectRef: 'uvwxyzabcdefghijklmn',
      name: 'wk-repo-pr-123',
      expectedProjectRef: 'abcdefghijklmnopqrst',
    }).catch((caught) => caught);

    expect(error.code).toBe('branch_expected_identity_requires_existing');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['is missing', null, 'branch_expected_missing'],
    [
      'has a different project ref',
      { branch_id: 'branch-2', project_ref: 'bcdefghijklmnopqrstu' },
      'branch_expected_project_ref_mismatch',
    ],
  ])('ensureBranch pinned-existing mode fails before mutation when the expected branch %s', async (
    _label,
    existing,
    expectedCode,
  ) => {
    jest.resetModules();
    const { ensureBranch } = require('../../../scripts/ops/workspace/supabase-api');
    const findBranchByNameFn = jest.fn().mockResolvedValue(existing);

    const error = await ensureBranch({
      token: 'tok',
      parentProjectRef: 'uvwxyzabcdefghijklmn',
      name: 'wk-repo-pr-123',
      requireExisting: true,
      expectedProjectRef: 'abcdefghijklmnopqrst',
      findBranchByNameFn,
    }).catch((caught) => caught);

    expect(error.code).toBe(expectedCode);
    expect(findBranchByNameFn).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['an inconclusive create response', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })],
    ['a generic 409 not yet visible to reads', Object.assign(new Error('Failed to provision branch project'), { status: 409 })],
  ])('ensureBranch fails closed when %s cannot be reconciled within the bounded window', async (_label, createError) => {
    jest.resetModules();
    const { ensureBranch } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockImplementationOnce(async () => {
      if (createError.code) throw createError;
      return {
        ok: false,
        status: createError.status,
        statusText: 'Conflict',
        text: async () => JSON.stringify({ message: createError.message }),
      };
    });
    const findBranchByNameFn = jest.fn().mockResolvedValue(null);
    const sleepFn = jest.fn().mockResolvedValue(undefined);

    const error = await ensureBranch({
      token: 'tok',
      parentProjectRef: 'uvwxyzabcdefghijklmn',
      name: 'wk-repo-pr-123',
      reuseExisting: true,
      reconcileAttempts: 2,
      reconcileDelayMs: 1,
      findBranchByNameFn,
      sleepFn,
    }).catch((caught) => caught);

    expect(error.code).toBe('branch_create_outcome_ambiguous');
    expect(findBranchByNameFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  test('ensureBranch fresh mode fails before mutation when the exact name already exists', async () => {
    jest.resetModules();
    const { ensureBranch } = require('../../../scripts/ops/workspace/supabase-api');
    const findBranchByNameFn = jest.fn().mockResolvedValue({
      branch_id: 'existing-branch-id',
      project_ref: 'abcdefghijklmnopqrst',
    });

    const error = await ensureBranch({
      token: 'tok',
      parentProjectRef: 'uvwxyzabcdefghijklmn',
      name: 'wk-repo-pr-123',
      reuseExisting: false,
      findBranchByNameFn,
    }).catch((caught) => caught);

    expect(error.code).toBe('branch_fresh_name_collision');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('ensureBranch fresh mode never claims a branch observed after a generic 409 create response', async () => {
    jest.resetModules();
    const { ensureBranch } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () => JSON.stringify({ message: 'Failed to provision branch project' }),
    });
    const findBranchByNameFn = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        branch_id: 'observed-after-timeout',
        project_ref: 'abcdefghijklmnopqrst',
      });

    const error = await ensureBranch({
      token: 'tok',
      parentProjectRef: 'uvwxyzabcdefghijklmn',
      name: 'wk-repo-pr-123',
      reuseExisting: false,
      findBranchByNameFn,
      sleepFn: jest.fn(),
    }).catch((caught) => caught);

    expect(error.code).toBe('branch_create_outcome_ambiguous');
    expect(error.observedBranchId).toBe('observed-after-timeout');
    expect(findBranchByNameFn).toHaveBeenCalledTimes(2);
  });

  test('deleteBranchWithRetries treats 404 as success', async () => {
    jest.resetModules();
    const { deleteBranchWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ message: 'not found' }),
    });

    await expect(deleteBranchWithRetries('branch-1', 'token', { timeoutMs: 1000, intervalMs: 0 })).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('deleteBranchWithRetries bounds a stalled DELETE by the remaining total deadline', async () => {
    jest.resetModules();
    const { deleteBranchWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    let nowMs = 0;
    const deleteBranchFn = jest.fn(async (_id, _token, { timeoutMs }) => {
      nowMs += timeoutMs;
      throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    });

    const error = await deleteBranchWithRetries('branch-1', 'token', {
      timeoutMs: 100,
      intervalMs: 20,
      nowFn: () => nowMs,
      sleepFn: jest.fn(),
      deleteBranchFn,
    }).catch((caught) => caught);

    expect(error.status).toBe(408);
    expect(deleteBranchFn).toHaveBeenCalledWith('branch-1', 'token', { timeoutMs: 100 });
    expect(nowMs).toBe(100);
  });

  test('deleteBranchWithRetries caps the final retry sleep to the remaining budget', async () => {
    jest.resetModules();
    const { deleteBranchWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
    let nowMs = 0;
    const notReady = Object.assign(new Error('branch not ready for deletion'), { status: 409 });
    const deleteBranchFn = jest.fn().mockRejectedValue(notReady);
    const sleepFn = jest.fn(async (delayMs) => {
      nowMs += delayMs;
    });

    await expect(deleteBranchWithRetries('branch-1', 'token', {
      timeoutMs: 10,
      intervalMs: 8,
      nowFn: () => nowMs,
      sleepFn,
      deleteBranchFn,
    })).rejects.toMatchObject({ status: 408 });

    expect(deleteBranchFn).toHaveBeenNthCalledWith(1, 'branch-1', 'token', { timeoutMs: 10 });
    expect(deleteBranchFn).toHaveBeenNthCalledWith(2, 'branch-1', 'token', { timeoutMs: 2 });
    expect(sleepFn).toHaveBeenNthCalledWith(1, 8);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 2);
    expect(nowMs).toBe(10);
  });

  test('listAuthSigningKeys unwraps keys response', async () => {
    jest.resetModules();
    const { listAuthSigningKeys } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          keys: [{ id: 'k1', algorithm: 'HS256', status: 'in_use' }],
        }),
    });
    await expect(listAuthSigningKeys('ref', 'token')).resolves.toEqual([
      expect.objectContaining({ id: 'k1', algorithm: 'HS256', status: 'in_use' }),
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/projects/ref/config/auth/signing-keys'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('createAuthSigningKey POSTs signing key payload', async () => {
    jest.resetModules();
    const { createAuthSigningKey } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      statusText: 'Created',
      text: async () => JSON.stringify({ id: 'k2', algorithm: 'HS256', status: 'standby' }),
    });

    await expect(
      createAuthSigningKey('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k2' }));

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/projects/ref/config/auth/signing-keys'),
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('\"algorithm\":\"HS256\"') }),
    );
  });

  test('updateAuthSigningKey PATCHes signing key status', async () => {
    jest.resetModules();
    const { updateAuthSigningKey } = require('../../../scripts/ops/workspace/supabase-api');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ id: 'k3', algorithm: 'HS256', status: 'in_use' }),
    });

    await expect(updateAuthSigningKey('ref', 'token', 'k3', { status: 'in_use' })).resolves.toEqual(
      expect.objectContaining({ id: 'k3', status: 'in_use' }),
    );

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/projects/ref/config/auth/signing-keys/k3'),
      expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('\"status\":\"in_use\"') }),
    );
  });

  test('selectAuthSigningKeyToRevoke prefers oldest non-HS256 previously_used key', () => {
    jest.resetModules();
    const { selectAuthSigningKeyToRevoke } = require('../../../scripts/ops/workspace/supabase-api');

    const selected = selectAuthSigningKeyToRevoke([
      {
        id: 'k-in-use',
        status: 'in_use',
        algorithm: 'ES256',
        raw: { created_at: '2026-02-01T00:00:00Z' },
      },
      {
        id: 'k-hs-old',
        status: 'previously_used',
        algorithm: 'HS256',
        raw: { created_at: '2026-01-01T00:00:00Z' },
      },
      {
        id: 'k-es-new',
        status: 'previously_used',
        algorithm: 'ES256',
        raw: { created_at: '2026-01-05T00:00:00Z' },
      },
      {
        id: 'k-es-old',
        status: 'previously_used',
        algorithm: 'ES256',
        raw: { created_at: '2026-01-02T00:00:00Z' },
      },
    ]);

    expect(selected).toEqual(expect.objectContaining({ id: 'k-es-old', algorithm: 'ES256' }));
  });

  test('createAuthSigningKeyInUse revokes a previously_used signing key on 422 and retries create', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    const onRevoke = jest.fn();

    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        text: async () =>
          JSON.stringify({
            message: 'There already are 3 previously used signing keys. To proceed first revoke at least 1.',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-old-es', algorithm: 'ES256', status: 'previously_used', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-old-hs', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-02T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'ES256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-old-es', status: 'revoked' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-old-es', algorithm: 'ES256', status: 'revoked', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-old-hs', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-02T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'ES256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-old-es', algorithm: 'ES256', status: 'revoked', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-old-hs', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-02T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'ES256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
        maxRevokeAttempts: 1,
        onRevoke,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-new' }));

    expect(onRevoke).toHaveBeenCalledTimes(1);
    expect(onRevoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'k-old-es', status: 'previously_used' }));

    const patchCalls = global.fetch.mock.calls
      .map((call) => ({ url: call[0], opts: call[1] }))
      .filter((call) => call.opts && call.opts.method === 'PATCH');

    expect(patchCalls.some((call) => String(call.url).includes('/signing-keys/k-old-es'))).toBe(true);
    expect(patchCalls.some((call) => String(call.url).includes('/signing-keys/k-new'))).toBe(true);
  });

  test('createAuthSigningKeyInUse demotes standby signing key on 422 and retries create', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    const onRevoke = jest.fn();
    const onRecycleStandby = jest.fn();

    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        text: async () =>
          JSON.stringify({
            message:
              'The project "ref" already has a signing key in standby "k-standby". Please change its status to in_use or previously_used to create a new signing key in standby status.',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-standby', algorithm: 'HS256', status: 'standby', created_at: '2026-01-10T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'ES256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-standby', status: 'previously_used' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-standby', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-10T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'ES256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-standby', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-10T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'ES256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
        maxRevokeAttempts: 1,
        onRevoke,
        onRecycleStandby,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-new' }));

    expect(onRevoke).toHaveBeenCalledTimes(1);
    expect(onRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'k-standby', status: 'standby', recovery: 'standby_conflict' }),
    );
    expect(onRecycleStandby).toHaveBeenCalledTimes(1);
    expect(onRecycleStandby).toHaveBeenCalledWith(expect.objectContaining({ id: 'k-standby', status: 'standby' }));

    const patchCalls = global.fetch.mock.calls
      .map((call) => ({ url: call[0], opts: call[1] }))
      .filter((call) => call.opts && call.opts.method === 'PATCH');

    const standbyPatch = patchCalls.find((call) => String(call.url).includes('/signing-keys/k-standby'));
    expect(standbyPatch).toBeDefined();
    expect(String(standbyPatch.opts.body || '')).toContain('"status":"previously_used"');
    expect(patchCalls.some((call) => String(call.url).includes('/signing-keys/k-new'))).toBe(true);
  });

  test('createAuthSigningKeyInUse recycles standby signing keys on 409 create conflicts and retries create', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: async () =>
          JSON.stringify({
            message: 'Failed to create new signing key in standby status for project',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-standby', algorithm: 'HS256', status: 'standby', created_at: '2026-01-10T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'ES256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-standby', status: 'previously_used' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-standby', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-10T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'ES256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
        maxRevokeAttempts: 1,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-new', status: 'in_use' }));
  });

  test('createAuthSigningKeyInUse promotes previously_used created signing keys through standby before in_use', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'previously_used' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-reused', status: 'in_use' }));

    const patchCalls = global.fetch.mock.calls
      .map((call) => ({ url: call[0], opts: call[1] }))
      .filter((call) => call.opts && call.opts.method === 'PATCH');

    expect(patchCalls).toHaveLength(2);
    expect(String(patchCalls[0].url || '')).toContain('/signing-keys/k-reused');
    expect(String(patchCalls[0].opts.body || '')).toContain('"status":"standby"');
    expect(String(patchCalls[1].url || '')).toContain('/signing-keys/k-reused');
    expect(String(patchCalls[1].opts.body || '')).toContain('"status":"in_use"');
  });

  test('createAuthSigningKeyInUse retries Supabase signing-key rate limits with wait-until guidance', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () =>
          JSON.stringify({
            message: 'Please wait until 2000-01-01T00:00:00.000Z before attempting this request again.',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-new', status: 'in_use' }));

    const postCalls = global.fetch.mock.calls.filter((call) => call[1]?.method === 'POST');
    expect(postCalls).toHaveLength(2);
  });

  test('createAuthSigningKeyInUse tolerates concurrent revoke transitions while freeing signing-key capacity', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        text: async () =>
          JSON.stringify({
            message: 'There already are 3 previously used signing keys. To proceed first revoke at least 1.',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-old-es', algorithm: 'ES256', status: 'previously_used', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'HS256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: async () => JSON.stringify({ message: 'Failed to set signing key status to "revoked"' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-old-es', algorithm: 'ES256', status: 'revoked', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-in-use', algorithm: 'HS256', status: 'in_use', created_at: '2026-02-01T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-new', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
        maxRevokeAttempts: 1,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-new', status: 'in_use' }));
  });

  test('createAuthSigningKeyInUse retries promotion when the created signing key regresses to previously_used', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        text: async () =>
          JSON.stringify({
            message:
              'Signing key has status "previously_used" and can\'t be moved to "in_use". Allowed status changes for this key are: standby, revoked',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [{ id: 'k-reused', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-01T00:00:00Z' }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-reused', status: 'in_use' }));
  });

  test('createAuthSigningKeyInUse recycles conflicting standby keys before promoting a previously_used key to standby', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'previously_used' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        text: async () =>
          JSON.stringify({
            message:
              'Signing key can\'t be promoted from "previously_used" to "standby" as key "k-standby" is already in standby. Change the other key\'s status to "in_use" or "previously_used" first.',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-reused', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-standby', algorithm: 'HS256', status: 'standby', created_at: '2026-01-02T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-standby', algorithm: 'HS256', status: 'previously_used' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-reused', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-standby', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-02T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-reused', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-standby', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-02T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-reused', status: 'in_use' }));
  });

  test('createAuthSigningKeyInUse recycles standby keys after generic standby-promotion conflicts', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'previously_used' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: async () => JSON.stringify({ message: 'Failed to set signing key status to "standby"' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-reused', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-standby', algorithm: 'HS256', status: 'standby', created_at: '2026-01-02T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-standby', algorithm: 'HS256', status: 'previously_used' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            keys: [
              { id: 'k-reused', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-01T00:00:00Z' },
              { id: 'k-standby', algorithm: 'HS256', status: 'previously_used', created_at: '2026-01-02T00:00:00Z' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'previously_used' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-reused', status: 'in_use' }));
  });

  test('createAuthSigningKeyInUse trusts transition hints when readback lags after in_use promotion races', async () => {
    jest.resetModules();
    const { createAuthSigningKeyInUse } = require('../../../scripts/ops/workspace/supabase-api');

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        text: async () =>
          JSON.stringify({
            message:
              'Signing key has status "previously_used" and can\'t be moved to "in_use". Allowed status changes for this key are: standby, revoked',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'standby' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ id: 'k-reused', algorithm: 'HS256', status: 'in_use' }),
      });

    await expect(
      createAuthSigningKeyInUse('ref', 'token', {
        algorithm: 'HS256',
        privateJwk: { kty: 'oct', k: 'abc', alg: 'HS256', use: 'sig' },
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'k-reused', status: 'in_use' }));
  });
});

describe('exact owned preview provider observation', () => {
  const { inspectOwnedPreviewWorkspace, listBranches } = require('../../../scripts/ops/workspace/supabase-api');
  const project = { ref: 'abcdefghijklmnopqrst', name: 'wk-masarx-pr-7', organization_id: 'org', created_at: '2026-10-18T08:00:00Z' };
  const ownership = { provider: 'supabase', workspace_mode: 'project', project_name: project.name, project_ref: project.ref };
  const observe = (rows, extra = {}) => inspectOwnedPreviewWorkspace({ token: 'synthetic', organizationId: 'org', ownership,
    listProjectsFn: jest.fn(async () => rows), ...extra });

  test('compares exact immutable project identity inside complete same-token visibility', async () => {
    const listProjectsFn = jest.fn(async () => [project]);
    await expect(observe([], { listProjectsFn })).resolves.toMatchObject({ absent: false, project_ref: project.ref });
    expect(listProjectsFn).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org', requireVerifiableResponse: true }));
    await expect(observe([{ ref: 'zyxwvutsrqponmlkjihg', name: 'foreign', organization_id: 'foreign' }]))
      .resolves.toEqual({ absent: true });
  });

  test.each([
    ['organization', { organization_id: 'other' }], ['name', { name: 'wk-masarx-pr-8' }],
    ['immutable ref rebound to name', { ref: 'zyxwvutsrqponmlkjihg' }],
    ['unknown creation', { created_at: null }], ['invalid creation', { created_at: 'invalid' }],
    ['future creation', { created_at: '2999-01-01T00:00:00Z' }],
  ])('rejects changed provider %s', async (_label, override) => {
    await expect(observe([{ ...project, ...override }])).rejects.toThrow();
  });

  test('rejects ambiguous names and unverifiable global absence', async () => {
    await expect(observe([project, { ...project, ref: 'zyxwvutsrqponmlkjihg' }])).rejects.toThrow('ambiguous');
    await expect(observe({ projects: [] })).rejects.toThrow('not verifiable');
  });

  test.each([0, -1, Infinity, '1000', 'unknown'])('rejects an unbounded provider observation budget %j', async timeoutMs => {
    await expect(observe([], { timeoutMs })).rejects.toThrow('deadline');
  });

  test('branch observation spends one shrinking budget across project and branch lookups', async () => {
    let clock = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const listProjectsFn = jest.fn(async () => {
      clock = 60;
      return [{ ...project, ref: 'ponmlkjihgfedcbazyxw' }];
    });
    const listBranchesFn = jest.fn(async () => []);
    try {
      await expect(observe([], { ownership: { ...ownership, workspace_mode: 'branch', branch_id: 'branch-owned',
        branch_parent_ref: 'ponmlkjihgfedcbazyxw' }, timeoutMs: 100, listProjectsFn, listBranchesFn }))
        .resolves.toEqual({ absent: true });
      expect(listBranchesFn).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 40 }));
    } finally { now.mockRestore(); }
  });

  test.each(['present', 'absent', 'wrong parent', 'wrong organization', 'unknown inventory'])('branch absence uses recorded immutable parent: %s', async mode => {
    const branchOwnership = { ...ownership, workspace_mode: 'branch', branch_id: 'branch-owned', branch_parent_ref: 'ponmlkjihgfedcbazyxw' };
    const parent = { ...project, ref: branchOwnership.branch_parent_ref, name: 'parent',
      organization_id: mode === 'wrong organization' ? 'foreign' : 'org' };
    const row = { branch_id: 'branch-owned', project_ref: project.ref, name: project.name,
      raw: { created_at: project.created_at, parent_project_ref: mode === 'wrong parent' ? 'zyxwvutsrqponmlkjihg' : branchOwnership.branch_parent_ref } };
    const listBranchesFn = jest.fn(async () => mode === 'unknown inventory' ? {} : mode === 'absent' ? [] : [row]);
    const promise = observe([parent], { ownership: branchOwnership, listBranchesFn });
    if (mode.startsWith('wrong') || mode === 'unknown inventory') await expect(promise).rejects.toThrow();
    else await expect(promise).resolves.toMatchObject({ absent: mode === 'absent' });
    if (mode !== 'wrong organization') expect(listBranchesFn).toHaveBeenCalledWith(expect.objectContaining({
      parentProjectRef: branchOwnership.branch_parent_ref, requireVerifiableResponse: true,
    }));
  });

  test.each([{}, { branches: 'unknown' }, [{ id: 'branch-owned', project_ref: project.ref, name: project.name, parent_project_ref: 'foreign' }]])(
    'strict branch listing rejects malformed or moved-parent evidence %j', async payload => {
      global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) }));
      await expect(listBranches({ token: 'synthetic', parentProjectRef: 'ponmlkjihgfedcbazyxw', requireVerifiableResponse: true }))
        .rejects.toThrow('unverifiable');
    },
  );
});

describe('optional GC delete-attempt guard', () => {
  const { deleteProjectWithRetries, deleteBranchWithRetries } = require('../../../scripts/ops/workspace/supabase-api');
  test.each(['project', 'branch'])('rechecks live authority before every %s DELETE retry', async mode => {
    let clock = 0;
    const beforeDelete = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('PR kept or reopened'));
    const request = jest.fn(async () => { throw Object.assign(new Error('transient'), { status: 503 }); });
    const options = { organizationId: 'org', timeoutMs: 1000, intervalMs: 1, beforeDelete,
      nowFn: () => clock, sleepFn: async ms => { clock += ms; },
      deleteProjectFn: request, deleteBranchFn: request };
    const promise = mode === 'project' ? deleteProjectWithRetries('abcdefghijklmnopqrst', 'synthetic', options)
      : deleteBranchWithRetries('owned-branch', 'synthetic', options);
    await expect(promise).rejects.toThrow('kept or reopened');
    expect(beforeDelete).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test.each(['project', 'branch'])('a %s guard cannot spend the remaining deadline then still send DELETE', async mode => {
    let clock = 0;
    const request = jest.fn();
    const options = { organizationId: 'org', timeoutMs: 100, beforeDelete: async () => { clock = 100; },
      nowFn: () => clock, deleteProjectFn: request, deleteBranchFn: request };
    const promise = mode === 'project' ? deleteProjectWithRetries('abcdefghijklmnopqrst', 'synthetic', options)
      : deleteBranchWithRetries('owned-branch', 'synthetic', options);
    await expect(promise).rejects.toThrow('Timeout');
    expect(request).not.toHaveBeenCalled();
  });
});
