const path = require('path');
const { pathToFileURL } = require('url');

const modulePath = pathToFileURL(path.resolve(
  __dirname,
  '../../../supabase/functions/api-caller/egress.mjs',
)).href;

const basePolicy = (overrides = {}) => ({
  transportMode: 'direct_trusted_host',
  domainAllowlist: ['8.8.8.8'],
  domainDenylist: [],
  allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  followRedirects: false,
  maxRedirects: 2,
  maxResponseBytes: 1024,
  ...overrides,
});

// Public addresses below are consumed only by injected DNS and fetch fakes.
const publicDns = async (_host, type) => type === 'A' ? ['8.8.8.8'] : [];

describe('api-caller bounded egress', () => {
  let egress;

  beforeAll(async () => {
    egress = await import(modulePath);
  });

  test.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.0.2.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '3fff::',
    '3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('rejects special-use address %s', (address) => {
    expect(egress.isPublicIpAddress(address)).toBe(false);
  });

  test('classifies the exact 3fff::/20 documentation boundary as non-public', () => {
    expect(egress.isPublicIpv6('3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
    expect(egress.isPublicIpv6('3fff:0000::1')).toBe(false);
    expect(egress.isPublicIpv6('3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(false);
    expect(egress.isPublicIpv6('3fff:1000::')).toBe(true);
  });

  test('requires canonical https URLs without userinfo', () => {
    expect(() => egress.canonicalizeHttpsUrl('http://provider.example')).toThrow('only https');
    expect(() => egress.canonicalizeHttpsUrl((['https',":","/","/",'user',":",'pass',"@",'provider.example'].join("")))).toThrow('userinfo');
    expect(egress.canonicalizeHttpsUrl('https://Provider.Example/path#fragment').href)
      .toBe('https://provider.example/path');
  });

  test('direct mode permits only an exact allowlisted public IP literal', async () => {
    const fetchImpl = jest.fn(async () => new Response('ok'));
    await expect(egress.executeBoundedEgress({
      url: 'https://provider.example/path',
      method: 'GET',
      timeoutMs: 1000,
      policy: basePolicy(),
      resolveDns: publicDns,
      directFetch: fetchImpl,
    })).rejects.toThrow('requires an exact public IP literal');
    await expect(egress.executeBoundedEgress({
      url: 'https://192.0.2.10/path',
      method: 'GET',
      timeoutMs: 1000,
      policy: basePolicy({ domainAllowlist: ['192.0.2.10'] }),
      resolveDns: publicDns,
      directFetch: fetchImpl,
    })).rejects.toThrow('requires an exact public IP literal');
    await expect(egress.executeBoundedEgress({
      url: 'https://1.1.1.1/path',
      method: 'GET',
      timeoutMs: 1000,
      policy: basePolicy(),
      resolveDns: publicDns,
      directFetch: fetchImpl,
    })).rejects.toThrow('not exactly allowlisted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('guarded proxy mode fails closed without the guarded transport', async () => {
    await expect(egress.executeBoundedEgress({
      url: 'https://dynamic.plugin.example/path',
      method: 'GET',
      timeoutMs: 1000,
      policy: basePolicy({
        transportMode: 'guarded_proxy',
        domainAllowlist: [],
      }),
      resolveDns: publicDns,
      directFetch: jest.fn(),
    })).rejects.toThrow('guarded proxy transport is unavailable');
  });

  test('guarded hostname mode fails closed when either DNS family fails', async () => {
    const guardedFetch = jest.fn(async () => new Response('ok'));
    await expect(egress.executeBoundedEgress({
      url: 'https://dynamic.plugin.example/path',
      method: 'GET',
      timeoutMs: 1000,
      policy: basePolicy({
        transportMode: 'guarded_proxy',
        domainAllowlist: ['dynamic.plugin.example'],
      }),
      resolveDns: async (_host, type) => {
        if (type === 'AAAA') throw new Error('resolver unavailable');
        return ['8.8.8.8'];
      },
      guardedFetch,
    })).rejects.toThrow('AAAA DNS lookup failed');
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  test('plain guarded allowlist entries match only the exact hostname', async () => {
    const guardedFetch = jest.fn(async () => new Response('ok'));
    await expect(egress.executeBoundedEgress({
      url: 'https://child.plugin.example/path',
      method: 'GET',
      timeoutMs: 1000,
      policy: basePolicy({
        transportMode: 'guarded_proxy',
        domainAllowlist: ['plugin.example'],
      }),
      resolveDns: publicDns,
      guardedFetch,
    })).rejects.toThrow('domain not present in allowlist');

    await expect(egress.executeBoundedEgress({
      url: 'https://child.plugin.example/path',
      method: 'GET',
      timeoutMs: 1000,
      policy: basePolicy({
        transportMode: 'guarded_proxy',
        domainAllowlist: ['*.plugin.example'],
      }),
      resolveDns: publicDns,
      guardedFetch,
    })).resolves.toMatchObject({ status: 200 });
  });

  test('manually validates redirects and strips credentials across origins', async () => {
    const requests = [];
    const fetchImpl = jest.fn(async (url, init) => {
      requests.push({ url, headers: new Headers(init.headers) });
      if (url === 'https://8.8.8.8/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://1.1.1.1/final' },
        });
      }
      return Response.json({ ok: true });
    });
    const result = await egress.executeBoundedEgress({
      url: 'https://8.8.8.8/start',
      method: 'GET',
      headers: {
        authorization: 'Bearer secret',
        'x-api-key': 'provider-secret',
        'x-provider-secret': 'custom-secret',
        accept: 'application/json',
      },
      timeoutMs: 1000,
      policy: basePolicy({
        followRedirects: true,
        domainAllowlist: ['8.8.8.8', '1.1.1.1'],
      }),
      resolveDns: publicDns,
      directFetch: fetchImpl,
    });
    expect(result.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[1].headers.has('authorization')).toBe(false);
    expect(requests[1].headers.has('x-api-key')).toBe(false);
    expect(requests[1].headers.has('x-provider-secret')).toBe(false);
    expect(requests[1].headers.get('accept')).toBe('application/json');
  });

  test('rejects redirect loops and responses over the configured bound', async () => {
    const loopFetch = jest.fn(async () => new Response(null, {
      status: 307,
      headers: { location: 'https://8.8.8.8/start' },
    }));
    await expect(egress.executeBoundedEgress({
      url: 'https://8.8.8.8/start',
      method: 'GET',
      timeoutMs: 1000,
      policy: basePolicy({ followRedirects: true }),
      resolveDns: publicDns,
      directFetch: loopFetch,
    })).rejects.toThrow('redirect loop');

    await expect(egress.executeBoundedEgress({
      url: 'https://8.8.8.8/start',
      method: 'GET',
      timeoutMs: 1000,
      policy: basePolicy({ maxResponseBytes: 3 }),
      resolveDns: publicDns,
      directFetch: async () => new Response('oversized'),
    })).rejects.toThrow('response exceeds 3 bytes');
  });


  test.each([
    ['missing', undefined], ['null', null], ['empty', []],
    ['scalar', 'GET'], ['object', { GET: true }], ['blank', ['']],
    ['lowercase', ['get']], ['whitespace', ['GET ']],
    ['mixed invalid', ['GET', null]], ['malformed', ['GET', 'BAD METHOD']],
    ['trailing newline', ['GET', 'POST\n']], ['trailing carriage return', ['GET', 'POST\r']],
  ])('rejects %s method policy before any DNS or fetch', async (_name, allowedMethods) => {
    const resolveDns = jest.fn(publicDns);
    const guardedFetch = jest.fn();
    const directFetch = jest.fn();
    await expect(egress.executeBoundedEgress({
      url: 'https://provider.example/start', method: 'GET', timeoutMs: 1000,
      policy: basePolicy({ allowedMethods, transportMode: 'guarded_proxy', domainAllowlist: ['provider.example'] }),
      resolveDns, guardedFetch, directFetch,
    })).rejects.toThrow('HTTP method GET is not allowed');
    expect(resolveDns).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });

  test('enforces method policy for a direct exported call before its first fetch', async () => {
    const directFetch = jest.fn();
    const resolveDns = jest.fn(publicDns);
    await expect(egress.executeBoundedEgress({
      url: 'https://8.8.8.8/start', method: 'GET', timeoutMs: 1000,
      policy: basePolicy({ allowedMethods: ['POST'] }), directFetch, resolveDns,
    })).rejects.toThrow('HTTP method GET is not allowed');
    expect(directFetch).not.toHaveBeenCalled();
    expect(resolveDns).not.toHaveBeenCalled();
  });

  test.each(['direct_trusted_host', 'guarded_proxy'].flatMap(transportMode =>
    [301, 302, 303].map(status => [transportMode, status]),
  ))('%s blocks POST-only policy after %s rewrites to GET', async (transportMode, status) => {
    const fetchImpl = jest.fn(async () => new Response(null, {
      status, headers: { location: '/final' },
    }));
    const resolveDns = jest.fn(publicDns);
    await expect(egress.executeBoundedEgress({
      url: transportMode === 'guarded_proxy' ? 'https://provider.example/start' : 'https://8.8.8.8/start',
      method: 'POST', body: 'payload', timeoutMs: 1000,
      policy: basePolicy({ transportMode, followRedirects: true, allowedMethods: ['POST'], domainAllowlist: ['provider.example', '8.8.8.8'] }),
      resolveDns, directFetch: fetchImpl, guardedFetch: fetchImpl,
    })).rejects.toThrow('HTTP method GET is not allowed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolveDns).toHaveBeenCalledTimes(transportMode === 'guarded_proxy' ? 2 : 0);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', body: 'payload', redirect: 'manual' });
  });

  test.each(['direct_trusted_host', 'guarded_proxy'].flatMap(transportMode =>
    [301, 302, 303, 307, 308].map(status => [transportMode, status]),
  ))('%s retains permitted method/body semantics through %s', async (transportMode, status) => {
    const rewrite = [301, 302, 303].includes(status);
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response(null, { status, headers: { location: '/final' } }))
      .mockResolvedValueOnce(new Response('ok'));
    const result = await egress.executeBoundedEgress({
      url: 'https://8.8.8.8/start', method: 'POST', body: 'payload',
      headers: { 'content-type': 'text/plain', 'content-length': '7' },
      timeoutMs: 1000,
      policy: basePolicy({ transportMode, followRedirects: true, allowedMethods: rewrite ? ['GET', 'POST'] : ['POST'] }),
      resolveDns: publicDns, directFetch: fetchImpl, guardedFetch: fetchImpl,
    });
    expect(result).toMatchObject({ status: 200, body: 'ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const next = fetchImpl.mock.calls[1][1];
    expect(fetchImpl.mock.calls[1][0]).toBe('https://8.8.8.8/final');
    expect(next.method).toBe(rewrite ? 'GET' : 'POST');
    expect(next.body).toBe(rewrite ? undefined : 'payload');
    expect(new Headers(next.headers).get('content-type')).toBe(rewrite ? null : 'text/plain');
    expect(new Headers(next.headers).get('content-length')).toBe(rewrite ? null : '7');
  });

  test('keeps one deadline active through response-body consumption', async () => {
    const slowBody = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('late'));
          controller.close();
        }, 30);
      },
    });
    await expect(egress.executeBoundedEgress({
      url: 'https://8.8.8.8/start',
      method: 'GET',
      timeoutMs: 5,
      policy: basePolicy(),
      resolveDns: publicDns,
      directFetch: async () => new Response(slowBody),
    })).rejects.toThrow('deadline exceeded');
  });
});
