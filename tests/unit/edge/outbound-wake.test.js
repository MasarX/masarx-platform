const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadRegistry, planDeploy } = require('../../../scripts/edge/functions-registry');

const modulePath = pathToFileURL(path.resolve(__dirname, '../../../supabase/functions/outbound-wake/relay.mjs')).href;
const baseUrl = `https://${['dispatch', 'example', 'test'].join('.')}`;
const dbJwt = ['server', 'edge', 'fixture'].join('.');
const anonKey = ['server', 'public', 'fixture'].join('-');

test('deploys the relay without JWT verification and keeps api-caller JWT-protected', () => {
  const { withJwt, noVerifyJwt } = planDeploy(loadRegistry());
  expect(noVerifyJwt.some(entry => entry.name === 'outbound-wake')).toBe(true);
  expect(withJwt.some(entry => entry.name === 'api-caller')).toBe(true);
});

describe('outbound wake relay', () => {
  let createOutboundWakeHandler;

  beforeAll(async () => {
    ({ createOutboundWakeHandler } = await import(modulePath));
  });

  function setup(fetchImpl, options = {}) {
    const tasks = [];
    const handler = createOutboundWakeHandler({
      supabaseUrl: `${baseUrl}/`, anonKey, dbJwt, fetchImpl,
      waitUntil: task => tasks.push(task),
      ...options,
    });
    return { handler, tasks };
  }

  test('ignores request headers and body and dispatches one server-resolved batch', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(Response.json(true))
      .mockResolvedValueOnce(Response.json({ jobs: [{ id: 'unused' }] }));
    const { handler, tasks } = setup(fetchImpl);
    const request = {
      method: 'POST',
      get headers() { throw new Error('request headers were read'); },
      get body() { throw new Error('request body was read'); },
      json() { throw new Error('request body was parsed'); },
    };

    const response = handler(request);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    await Promise.all(tasks);

    expect(fetchImpl.mock.calls).toEqual([
      [`${baseUrl}/rest/v1/rpc/try_start_outbound_wake_v1`, expect.objectContaining({
        method: 'POST', redirect: 'error', body: '{}',
        headers: {
          authorization: `Bearer ${dbJwt}`, apikey: anonKey,
          'content-type': 'application/json', 'content-profile': 'api',
        },
      })],
      [`${baseUrl}/functions/v1/api-caller`, expect.objectContaining({
        method: 'POST', redirect: 'error', body: '{"batch":1}',
        headers: { authorization: `Bearer ${dbJwt}`, 'content-type': 'application/json' },
      })],
    ]);
  });

  test.each([true, false])('acknowledges before admission settles, with due work = %s', async (due) => {
    let admit;
    const fetchImpl = jest.fn()
      .mockReturnValueOnce(new Promise(resolve => { admit = resolve; }))
      .mockResolvedValueOnce(new Response());
    const { handler, tasks } = setup(fetchImpl);
    const response = handler(new Request(baseUrl, { method: 'POST' }));
    expect([response.status, [...response.headers], await response.text()]).toEqual([202, [], '']);
    admit(Response.json(due));
    await Promise.all(tasks);
    expect(fetchImpl).toHaveBeenCalledTimes(due ? 2 : 1);
  });

  test('uses shared admission for overlapping wakes and a later empty sweep', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(Response.json(true))
      .mockResolvedValueOnce(Response.json(false))
      .mockResolvedValueOnce(new Response())
      .mockResolvedValueOnce(Response.json(true))
      .mockResolvedValueOnce(new Response());
    const first = setup(fetchImpl);
    const second = setup(fetchImpl);
    const sweepSignal = () => new Request(baseUrl, { method: 'POST', body: '{}' });
    first.handler(sweepSignal());
    second.handler(sweepSignal());
    await Promise.all([...first.tasks, ...second.tasks]);
    const isDispatch = ([url]) => url.endsWith('/api-caller');
    expect(fetchImpl.mock.calls.filter(isDispatch)).toHaveLength(1);

    second.handler(sweepSignal());
    await Promise.all(second.tasks);
    expect(fetchImpl.mock.calls.filter(isDispatch)).toHaveLength(2);
  });

  test('ignores non-POST requests without changing the response', async () => {
    const fetchImpl = jest.fn();
    const { handler, tasks } = setup(fetchImpl);
    const response = handler(new Request(baseUrl, { method: 'OPTIONS' }));
    expect([response.status, [...response.headers], await response.text()]).toEqual([202, [], '']);
    expect(tasks).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(['admission', 'dispatch'])('logs a fixed message for a %s failure', async (stage) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchImpl = jest.fn().mockRejectedValue(new Error(`${baseUrl} ${dbJwt} ${anonKey}`));
      if (stage === 'dispatch') fetchImpl.mockResolvedValueOnce(Response.json(true));
      const { handler, tasks } = setup(fetchImpl);
      const response = handler(new Request(baseUrl, { method: 'POST' }));
      await Promise.all(tasks);
      expect([response.status, await response.text()]).toEqual([202, '']);
      expect(warn.mock.calls).toEqual([[`[outbound-wake] ${stage} failed`]]);
    } finally {
      warn.mockRestore();
    }
  });
});
