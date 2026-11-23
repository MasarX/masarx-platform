const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { guard } = require('../../../scripts/deploy/apply-guard.cjs');

const tip = 'a'.repeat(40);
let dir;
let env;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-guard-retry-'));
  env = {
    GITHUB_API_URL: 'https://example.test',
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_SHA: tip,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
    GH_TOKEN: ['synthetic', 'value'].join('-'),
  };
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  fs.rmSync(env.GITHUB_OUTPUT, { force: true });
  fs.rmSync(env.GITHUB_STEP_SUMMARY, { force: true });
  fs.rmdirSync(dir);
});

function githubFetch() {
  return jest.fn(async url => url.endsWith('/git/ref/heads/main')
    ? Response.json({ object: { sha: tip } })
    : Response.json({ workflow_runs: [] }));
}

test.each([
  ['a terminated fetch', () => { throw new TypeError('terminated'); }, 'network'],
  ['a fetch failure without a cause', () => { throw new TypeError('fetch failed'); }, 'network'],
  ['a connection reset', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    throw new TypeError('fetch failed', { cause });
  }, 'network'],
  ['HTTP 429', () => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }), 'http-429'],
  ['a request AbortError', () => { throw new DOMException('request aborted', 'AbortError'); }, 'timeout'],
  ['a request TimeoutError', () => { throw new DOMException('request timed out', 'TimeoutError'); }, 'timeout'],
])('recovers from %s by retrying the same GET after one second', async (_label, fail, reason) => {
  const fetchRequest = githubFetch().mockImplementationOnce(async () => fail());
  const result = guard(env, fetchRequest);

  await jest.advanceTimersByTimeAsync(999);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe(0);
  expect(fetchRequest).toHaveBeenCalledTimes(4);
  const [[url, first], [retryUrl, retry]] = fetchRequest.mock.calls;
  expect(retryUrl).toBe(url);
  expect([first.method, retry.method]).toEqual(['GET', 'GET']);
  expect(retry.signal).not.toBe(first.signal);
  expect(console.log.mock.calls[0]).toEqual([`guard_api_retry attempt=2 reason=${reason}`]);
  expect(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('superseded=false\n');
});

test('retries a dropped response body without evaluating earlier decisions again', async () => {
  const fetchRequest = githubFetch()
    .mockResolvedValueOnce(Response.json({ object: { sha: tip } }))
    .mockResolvedValueOnce({ ok: true, json: async () => { throw new TypeError('terminated'); } });
  const result = guard(env, fetchRequest);

  await jest.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toBe(0);
  expect(fetchRequest).toHaveBeenCalledTimes(4);
  expect(fetchRequest.mock.calls[2][0]).toBe(fetchRequest.mock.calls[1][0]);
  expect(console.log.mock.calls).toEqual([
    ['G1: no superseding push'],
    ['G3: not applicable to push'],
    ['guard_api_retry attempt=2 reason=network'],
    ['G2: no previous apply found'],
  ]);
});

test('fails closed after three dropped requests with three seconds of total backoff', async () => {
  const timeout = jest.spyOn(AbortSignal, 'timeout');
  const fetchRequest = jest.fn()
    .mockRejectedValueOnce(new Error('socket hang up'))
    .mockRejectedValueOnce(new TypeError('terminated'))
    .mockRejectedValue(Object.assign(new Error(`terminated\r\n${env.GH_TOKEN}`), { code: 'ECONNRESET' }));
  const result = guard(env, fetchRequest);

  await jest.advanceTimersByTimeAsync(1000);
  expect(fetchRequest).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1999);
  expect(fetchRequest).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe(1);
  expect(fetchRequest).toHaveBeenCalledTimes(3);
  expect(timeout.mock.calls).toEqual([[15_000], [15_000], [15_000]]);
  expect(jest.getTimerCount()).toBe(0);
  expect(console.log.mock.calls).toEqual([
    ['guard_api_retry attempt=2 reason=network'],
    ['guard_api_retry attempt=3 reason=network'],
  ]);
  expect(fs.existsSync(env.GITHUB_OUTPUT)).toBe(false);
  const message = 'Guard could not verify GitHub deployment state: terminated [redacted]';
  expect(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toBe(`## DEV database guard\n\n- ${message}\n`);
  expect(console.error.mock.calls).toEqual([[`::error::${message}`]]);
});

test.each([403, 404, 408, 503])('fails closed on HTTP %i after one GET', async status => {
  const fetchRequest = jest.fn().mockResolvedValue(new Response(null, {
    status, headers: { 'Retry-After': '1' },
  }));
  const result = guard(env, fetchRequest);

  await jest.advanceTimersByTimeAsync(3000);
  await expect(result).resolves.toBe(1);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
  expect(console.log).not.toHaveBeenCalled();
  expect(fs.existsSync(env.GITHUB_OUTPUT)).toBe(false);
  expect(console.error).toHaveBeenCalledWith(
    `::error::Guard could not verify GitHub deployment state: GitHub API returned HTTP ${status} for /git/ref/heads/main`,
  );
});

test('refuses an unexpected redirect without retrying the fetch rejection', async () => {
  const fetchRequest = jest.fn().mockRejectedValue(new TypeError('fetch failed', {
    cause: new Error('unexpected redirect'),
  }));
  const result = guard(env, fetchRequest);

  await jest.advanceTimersByTimeAsync(3000);
  await expect(result).resolves.toBe(1);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
  expect(console.log).not.toHaveBeenCalled();
  expect(fs.existsSync(env.GITHUB_OUTPUT)).toBe(false);
});
