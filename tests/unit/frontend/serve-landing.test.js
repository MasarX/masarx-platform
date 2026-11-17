jest.mock('../../../scripts/utils/load-env', () => ({
  loadEnv: jest.fn(),
}));

const { Readable } = require('node:stream');
const http = require('node:http');
const { handleLocalIntakeMock, isTruthy, main, stripMountPrefix } = require('../../../scripts/frontend/serve-landing');

async function invokeMock({ url = '/__landing-contact', method = 'POST', body = JSON.stringify({
  email: 'local@example.test', full_name: 'Example Person', organization_name: 'Example', locale: 'en',
}), headers = {}, options = {} } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { url, method, headers: { host: 'landing-ci.localhost:3333', 'content-type': 'application/json', ...headers } });
  const res = { writeHead: jest.fn(), end: jest.fn() };
  const handled = await handleLocalIntakeMock(req, res, { enabled: true, siteUrl: 'http://landing-ci.localhost:3333', ...options });
  return { handled, res, status: res.writeHead.mock.calls[0]?.[0], body: res.end.mock.calls.length ? JSON.parse(res.end.mock.calls[0][0]) : null };
}

describe('serve-landing', () => {
  function startServer(env, assert) {
    const server = { on: jest.fn(), listen: jest.fn() };
    const createServer = jest.spyOn(http, 'createServer').mockReturnValue(server);
    const environment = jest.replaceProperty(process, 'env', { LANDING_SKIP_BUILD: '1', ...env });
    try {
      assert(() => main(), server, createServer);
    } finally {
      environment.restore();
      createServer.mockRestore();
    }
  }

  test.each(['', 'localhost', '127.0.0.1', '::1'])('mock startup binds only to the selected loopback interface: %s', (host) => {
    startServer({ LANDING_ENABLE_INTAKE_MOCKS: '1', LANDING_HOST: host }, (start, server) => {
      start();
      expect(server.listen).toHaveBeenCalledWith(3333, host || '127.0.0.1', expect.any(Function));
    });
  });

  test.each(['0.0.0.0', '::', '[::]', '192.0.2.10', 'example.com', 'landing-ci.localhost', '127.0.0.1.example.com'])
    ('mock startup rejects unsafe host overrides before creating a server: %s', (host) => {
      startServer({ LANDING_ENABLE_INTAKE_MOCKS: '1', LANDING_HOST: host, LANDING_SITE_URL: 'http://localhost:3333' }, (start, server, createServer) => {
        expect(start).toThrow(/requires LANDING_HOST/);
        expect(createServer).not.toHaveBeenCalled();
        expect(server.listen).not.toHaveBeenCalled();
      });
    });

  test.each(['', '0.0.0.0', '::', '192.0.2.10'])('mock-disabled startup preserves its existing bind: %s', (host) => {
    startServer({ LANDING_HOST: host }, (start, server) => {
      start();
      expect(server.listen).toHaveBeenCalledWith(3333, host || undefined, expect.any(Function));
    });
  });

  test('mounts a child export without serving sibling Console paths', () => {
    expect(stripMountPrefix('/fieldops/', '/fieldops/')).toBe('/');
    expect(stripMountPrefix('/fieldops/_expo/static/main.js?x=1', '/fieldops/')).toBe('/_expo/static/main.js?x=1');
    expect(stripMountPrefix('/', '/fieldops/')).toBeNull();
    expect(stripMountPrefix('/fieldops-other/index.html', '/fieldops/')).toBeNull();
    expect(stripMountPrefix('/assets/main.js')).toBe('/assets/main.js');
  });
  test('recognizes truthy skip-build flags', () => {
    expect(isTruthy('1')).toBe(true);
    expect(isTruthy('true')).toBe(true);
    expect(isTruthy('yes')).toBe(true);
    expect(isTruthy('on')).toBe(true);
    expect(isTruthy('0')).toBe(false);
    expect(isTruthy('')).toBe(false);
  });

  test('implements separate POST mock routes with frontend JSON and each intake receipt shape', async () => {
    const contact = await invokeMock();
    const tenant = await invokeMock({ url: '/__tenant-signup/?source=proof' });
    expect(contact).toMatchObject({ handled: true, status: 200, body: { ok: true, mock: true, id: expect.any(String), status: 'under_review' } });
    expect(tenant).toMatchObject({ handled: true, status: 200, body: { ok: true, mock: true, request_id: expect.any(String), status: 'under_review' } });
    expect(contact.body.id).not.toBe(tenant.body.request_id);
    expect(contact.body.request_id).toBeUndefined();
    expect(tenant.body.id).toBeUndefined();
  });

  test('mock routes are disabled by default and never take over another endpoint', async () => {
    const req = { url: '/__landing-contact' };
    const res = { writeHead: jest.fn(), end: jest.fn() };
    expect(await handleLocalIntakeMock(req, res)).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
    expect((await invokeMock({ options: { enabled: false } })).handled).toBe(false);
    expect((await invokeMock({ url: '/functions/v1/tenant-signup-intake' })).handled).toBe(false);
  });

  test.each([
    [{ options: { siteUrl: 'https://landing.example.com' } }, 403],
    [{ options: { siteUrl: '' } }, 403],
    [{ headers: { host: 'landing.example.com' } }, 403],
    [{ method: 'GET' }, 405],
    [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ body: '{' }, 400],
    [{ body: '[]' }, 400],
    [{ body: 'null' }, 400],
    [{ body: 'x'.repeat(64 * 1024 + 1) }, 413],
  ])('rejects unsafe or unsupported mock requests: %s', async (input, status) => {
    expect(await invokeMock(input)).toMatchObject({ handled: true, status, body: { ok: false, mock: true, error: { code: expect.any(String) } } });
  });
});
