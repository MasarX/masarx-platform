const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = pathToFileURL(path.resolve(__dirname, '../../../supabase/functions/outbound-wake/relay.mjs')).href;
const baseUrl = `https://${['inline-wake', 'example', 'test'].join('.')}`;
const relayUrl = `${baseUrl}/functions/v1/outbound-wake`;
const inlineRpc = '/rest/v1/rpc/try_start_inline_outbound_wake_v1';
const sweepRpc = '/rest/v1/rpc/try_start_outbound_wake_v1';
const worker = '/functions/v1/api-caller';

describe('inline outbound wake relay', () => {
  let createOutboundWakeHandler;

  beforeAll(async () => {
    ({ createOutboundWakeHandler } = await import(modulePath));
  });

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(fetchImpl) {
    const tasks = [];
    const handler = createOutboundWakeHandler({
      supabaseUrl: baseUrl,
      anonKey: ['relay', 'public', 'fixture'].join('-'),
      dbJwt: ['relay', 'server', 'fixture'].join('.'),
      fetchImpl,
      waitUntil: task => tasks.push(task),
    });
    return { handler, tasks };
  }

  const signal = (inline = true) => new Request(inline ? `${relayUrl}?inline=1` : relayUrl, { method: 'POST' });
  const paths = fetchImpl => fetchImpl.mock.calls.map(([url]) => new URL(url).pathname);
  const batch = claimed => Response.json({ summary: { claimed } });

  test('drains up to three inline batches even while the minute relay is locally throttled', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(Response.json(false))
      .mockResolvedValueOnce(Response.json(2000))
      .mockResolvedValueOnce(batch(1))
      .mockResolvedValueOnce(batch(10))
      .mockResolvedValueOnce(batch(10));
    const { handler, tasks } = setup(fetchImpl);
    handler(signal(false));
    const response = handler(signal());
    await jest.advanceTimersByTimeAsync(1999);
    handler(signal(false));
    expect([response.status, await response.text(), tasks.length]).toEqual([202, '', 2]);
    expect(paths(fetchImpl)).toEqual([sweepRpc, inlineRpc, worker]);

    await jest.advanceTimersByTimeAsync(1);
    await Promise.all(tasks);
    expect(paths(fetchImpl)).toEqual([sweepRpc, inlineRpc, worker, worker, worker]);
    expect(fetchImpl.mock.calls.slice(2).map(([, options]) => options.body))
      .toEqual(['{"batch":10}', '{"batch":10}', '{"batch":10}']);
  });

  test.each([[null, 0], [0, 1]])('bounds a public inline signal when SQL admission returns %s', async (admitted, batches) => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(Response.json(admitted))
      .mockResolvedValueOnce(batch(2));
    const { handler, tasks } = setup(fetchImpl);
    handler(signal());
    await Promise.all(tasks);
    expect(paths(fetchImpl)).toEqual([inlineRpc, ...Array(batches).fill(worker)]);
    expect(fetchImpl.mock.calls[0][1].body).toBe('{}');
  });

  test('coalesces admission traffic and drains at the newer SQL reservation deadline', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(Response.json(null))
      .mockResolvedValueOnce(Response.json(750))
      .mockResolvedValueOnce(batch(2))
      .mockResolvedValueOnce(batch(2));
    const { handler, tasks } = setup(fetchImpl);
    handler(signal());
    await jest.advanceTimersByTimeAsync(1000);
    handler(signal());
    handler(signal());
    await jest.advanceTimersByTimeAsync(999);
    expect(tasks).toHaveLength(2);
    expect(paths(fetchImpl)).toEqual([inlineRpc]);

    await jest.advanceTimersByTimeAsync(750);
    expect(paths(fetchImpl)).toEqual([inlineRpc, inlineRpc, worker]);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all(tasks);
    expect(paths(fetchImpl)).toEqual([inlineRpc, inlineRpc, worker, worker]);
  });
});
