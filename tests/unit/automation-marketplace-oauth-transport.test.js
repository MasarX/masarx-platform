const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
let createTokenTransport;
beforeAll(async () => {
  ({ createTokenTransport } = await import(pathToFileURL(path.resolve(__dirname,
    '../../apps/console/app/api/automation-marketplace/oauth/_lib/token-transport.mjs')).href));
});

// Public addresses below are consumed only by injected DNS and socket fakes.
function fixture({ addresses = [{ address: '8.8.8.8', family: 4 }], chunks = ['{"access_token":"secret"}'], status = 200,
  type = 'application/json', requestError = null, noResponse = false } = {}) {
  const lookup = jest.fn(async () => addresses);
  const response = Object.assign(new EventEmitter(), { statusCode: status, headers: { 'content-type': type }, destroy: jest.fn() });
  let options;
  const pending = Object.assign(new EventEmitter(), { destroy: jest.fn(), end: jest.fn(() => {
    queueMicrotask(() => {
      if (requestError) pending.emit('error', new Error(requestError));
      else if (!noResponse) {
        callback(response);
        for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
        response.emit('end');
      }
    });
  }) });
  let callback;
  const request = jest.fn((_url, config, onResponse) => { options = config; callback = onResponse; return pending; });
  return { lookup, request, pending, response, get options() { return options; }, run: createTokenTransport({ lookup, request }) };
}

test('pins all-public DNS to the actual socket and preserves hostname TLS checks/form encoding', async () => {
  const h = fixture();
  const refreshToken = ['fixture', 'refresh'].join('&');
  expect(await h.run('https://identity.example.test/token', { refresh_token: refreshToken, grant_type: 'refresh_token' }))
    .toEqual({ status: 200, body: { access_token: 'secret' } });
  expect(h.lookup).toHaveBeenCalledWith('identity.example.test', { all: true, verbatim: true });
  expect(h.options).toMatchObject({ method: 'POST', agent: false, servername: 'identity.example.test', rejectUnauthorized: true });
  expect(h.request.mock.calls[0][0].hostname).toBe('identity.example.test');
  expect(h.options.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
  const callback = jest.fn(); h.options.lookup('identity.example.test', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  const all = jest.fn(); h.options.lookup('identity.example.test', { all: true }, all);
  expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
  expect(h.pending.end).toHaveBeenCalledWith('refresh_token=fixture%26refresh&grant_type=refresh_token');
});

test.each([
  [], [{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
  [{ address: '::1', family: 6 }], [{ address: '::ffff:127.0.0.1', family: 6 }], [{ address: '192.0.2.10', family: 4 }],
])('rejects empty/private/mixed DNS before opening a socket: %j', async (...rows) => {
  const addresses = rows.length === 1 && Array.isArray(rows[0]) ? rows[0] : rows;
  const h = fixture({ addresses });
  await expect(h.run('https://identity.example.test/token', {})).rejects.toThrow('OAuth token request failed');
  expect(h.request).not.toHaveBeenCalled();
});

test.each(['http://identity.example.test/token', (['https',":","/","/",'user',":",'pass',"@",'identity.example.test',"/",'token'].join("")), 'https://identity.example.test:8443/token', 'https://identity.example.test/token#fragment'])
  ('rejects unsafe endpoint %s before DNS', async (endpoint) => {
    const h = fixture(); await expect(h.run(endpoint, {})).rejects.toThrow('OAuth token request failed'); expect(h.lookup).not.toHaveBeenCalled();
  });

test('DNS failure is redacted before opening any socket', async () => {
  const h = fixture(); h.lookup.mockRejectedValueOnce(new Error('internal-resolver-private-value'));
  await expect(h.run('https://identity.example.test/token', {})).rejects.toThrow(/^OAuth token request failed\.$/);
  expect(h.request).not.toHaveBeenCalled();
});

test.each([
  { status: 302 }, { type: 'text/html' }, { chunks: ['not-json'] }, { chunks: ['x'.repeat(65_537)] },
  { requestError: 'TLS certificate error secret&provider-credential' },
])('redirect/format/size/TLS failure is redacted and never retried: %j', async (options) => {
  const h = fixture(options); await expect(h.run('https://identity.example.test/token', {})).rejects.toThrow(/^OAuth token request failed\.$/);
  expect(h.request).toHaveBeenCalledTimes(1); expect(h.pending.destroy).toHaveBeenCalledTimes(1);
});

test('the whole deadline includes DNS; late resolution cannot open a socket', async () => {
  jest.useFakeTimers();
  try {
    let resolve;
    const lookup = jest.fn(() => new Promise((done) => { resolve = done; }));
    const request = jest.fn();
    const promise = createTokenTransport({ lookup, request })('https://identity.example.test/token', {});
    const assertion = expect(promise).rejects.toThrow('OAuth token request failed');
    await Promise.resolve(); await jest.advanceTimersByTimeAsync(10_000); await assertion;
    resolve([{ address: '8.8.8.8', family: 4 }]); await Promise.resolve(); await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test('a stalled provider response is destroyed at the same deadline', async () => {
  jest.useFakeTimers();
  try {
    const h = fixture({ noResponse: true }); const promise = h.run('https://identity.example.test/token', {});
    const assertion = expect(promise).rejects.toThrow('OAuth token request failed');
    await Promise.resolve(); await Promise.resolve(); await jest.advanceTimersByTimeAsync(10_000); await assertion;
    expect(h.pending.destroy).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});
