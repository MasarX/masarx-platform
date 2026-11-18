const path = require('path');
const { pathToFileURL } = require('url');

const modulePath = pathToFileURL(path.resolve(
  __dirname,
  '../../../supabase/functions/api-caller/proxy.mjs',
)).href;

describe('api-caller guarded proxy transport', () => {
  let proxy;

  beforeAll(async () => {
    proxy = await import(modulePath);
  });

  test('accepts only an exact HTTPS proxy origin', () => {
    expect(proxy.resolveGuardedProxyConfiguration({
      url: 'https://Proxy.Example:8443',
    })).toEqual({
      url: 'https://proxy.example:8443',
      basicAuth: undefined,
    });

    for (const url of [
      '',
      'not-a-url',
      'http://proxy.example',
      (['https',":","/","/",'user',":",'pass',"@",'proxy.example'].join("")),
      'https://proxy.example/tunnel',
      'https://proxy.example?mode=unsafe',
      'https://proxy.example#fragment',
    ]) {
      expect(() => proxy.resolveGuardedProxyConfiguration({ url }))
        .toThrow(/proxy URL|HTTPS origin/);
    }
  });

  test('passes separately configured credentials through Deno proxy basicAuth', async () => {
    const client = { id: 'guarded-client' };
    const createHttpClient = jest.fn(() => client);
    const fetchImpl = jest.fn(async () => new Response('ok'));
    const guardedFetch = proxy.createGuardedProxyFetch({
      url: 'https://proxy.example',
      username: 'operator',
      password: 'high-entropy-secret',
      createHttpClient,
      fetchImpl,
    });

    await guardedFetch('https://destination.example/path', { method: 'GET' });
    await guardedFetch('https://destination.example/next', { method: 'GET' });

    expect(createHttpClient).toHaveBeenCalledTimes(1);
    expect(createHttpClient).toHaveBeenCalledWith({
      proxy: {
        url: 'https://proxy.example',
        basicAuth: { username: 'operator', password: 'high-entropy-secret' },
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://destination.example/path',
      expect.objectContaining({ client, method: 'GET' }),
    );
  });

  test('fails closed on partial or malformed credentials', () => {
    for (const credentials of [
      { username: 'operator', password: '' },
      { username: '', password: 'secret' },
      { username: 'bad:name', password: 'secret' },
      { username: 'bad\nname', password: 'secret' },
      { username: 'operator', password: 'bad\nsecret' },
    ]) {
      expect(() => proxy.resolveGuardedProxyConfiguration({
        url: 'https://proxy.example',
        ...credentials,
      })).toThrow(/configured together|credentials are invalid/);
    }
  });

  test('redacts proxy configuration from runtime failures', async () => {
    const secret = 'do-not-leak-this-secret';
    const guardedFetch = proxy.createGuardedProxyFetch({
      url: 'https://sensitive-proxy.example',
      username: 'sensitive-user',
      password: secret,
      createHttpClient: () => {
        throw new Error(`cannot connect sensitive-user:${secret}@sensitive-proxy.example`);
      },
      fetchImpl: jest.fn(),
    });

    let failure;
    try {
      await guardedFetch('https://destination.example', { method: 'GET' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Deno guarded proxy client initialization failed');
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain('sensitive-user');
    expect(failure.message).not.toContain('sensitive-proxy.example');
  });

  test('redacts proxy configuration from request failures', async () => {
    const secret = 'request-secret-must-not-leak';
    const guardedFetch = proxy.createGuardedProxyFetch({
      url: 'https://sensitive-proxy.example',
      username: 'sensitive-user',
      password: secret,
      createHttpClient: () => ({ id: 'client' }),
      fetchImpl: async () => {
        throw new Error(`proxy sensitive-user:${secret}@sensitive-proxy.example rejected request`);
      },
    });

    let failure;
    try {
      await guardedFetch('https://destination.example', { method: 'GET' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Guarded egress proxy request failed');
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain('sensitive-user');
    expect(failure.message).not.toContain('sensitive-proxy.example');
  });

  test('fails closed when the runtime proxy client is unavailable', async () => {
    const guardedFetch = proxy.createGuardedProxyFetch({
      url: 'https://proxy.example',
      createHttpClient: undefined,
      fetchImpl: jest.fn(),
    });
    await expect(guardedFetch('https://destination.example', { method: 'GET' }))
      .rejects.toThrow('proxy transport is unavailable');
  });
});
