const fs = require('fs');
const path = require('path');
const {
  RETRYABLE_STATUS_CODES,
  RETRYABLE_NETWORK_ERROR_CODES,
  buildHeaders,
  isRetryableGithubApiFailure,
  isRetryableGithubBinaryBufferFailure,
  resolveGithubRateLimitRetry,
  requestGithubJson,
  downloadGithubBinary,
  downloadGithubBinaryBuffer,
} = require('../../../scripts/ops/ci/github-api-retry');

describe('github-api-retry', () => {
  const realFetch = global.fetch;
  const binaryResponse = (chunks, headers = {}) => new Response(
    new Blob(chunks.map((chunk) => Buffer.from(chunk))).stream(),
    { status: 200, headers },
  );
  const errorResponse = (status, message, headers = {}) => new Response(
    JSON.stringify({ message }),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  );
  const readerResponse = (reader, headers = {}) => ({
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: { getReader: () => reader },
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
    delete process.env.GITHUB_API_MAX_ATTEMPTS;
    delete process.env.GITHUB_API_RETRY_DELAY_MS;
    fs.rmSync(path.resolve(__dirname, '../../.tmp'), { recursive: true, force: true });
  });

  test('classifies retryable GitHub API failures', () => {
    expect(RETRYABLE_STATUS_CODES.has(502)).toBe(true);
    expect(isRetryableGithubApiFailure({ status: 502, message: 'Server Error' })).toBe(true);
    expect(isRetryableGithubApiFailure({ status: 429, message: 'Too Many Requests' })).toBe(true);
    expect(isRetryableGithubApiFailure({ status: 403, message: 'Forbidden' })).toBe(false);
    expect(isRetryableGithubApiFailure({ status: 403, message: 'rate limit', rateLimited: true })).toBe(true);
    expect(isRetryableGithubApiFailure({ status: 404, message: 'Not Found' })).toBe(false);
    expect(isRetryableGithubApiFailure({ message: 'fetch failed: socket hang up' })).toBe(true);
  });

  test('classifies bounded nested binary transport causes without treating terminated as retryable', () => {
    expect(RETRYABLE_NETWORK_ERROR_CODES.has('UND_ERR_SOCKET')).toBe(true);
    expect(RETRYABLE_NETWORK_ERROR_CODES.has('UND_ERR_CONNECT_TIMEOUT')).toBe(true);
    expect(RETRYABLE_NETWORK_ERROR_CODES.has('ECONNRESET')).toBe(true);

    const nested = new Error('terminated');
    nested.cause = new Error('fetch body failed');
    nested.cause.cause = Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' });
    expect(isRetryableGithubBinaryBufferFailure(nested)).toBe(true);

    const connectTimeout = new Error('fetch failed');
    connectTimeout.cause = Object.assign(new Error('connection deadline'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    expect(isRetryableGithubBinaryBufferFailure(connectTimeout)).toBe(true);

    const nonRetryable = new Error('terminated');
    nonRetryable.cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(isRetryableGithubBinaryBufferFailure(nonRetryable)).toBe(false);
    for (const message of ['fetch failed', 'socket hang up', 'aborted']) {
      expect(isRetryableGithubBinaryBufferFailure(Object.assign(new Error(message), { code: 'EACCES' }))).toBe(false);
    }

    const cyclic = Object.assign(new Error('terminated'), { code: 'EACCES' });
    cyclic.cause = cyclic;
    expect(isRetryableGithubBinaryBufferFailure(cyclic)).toBe(false);

    let tooDeep = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    for (let depth = 0; depth < 8; depth += 1) tooDeep = Object.assign(new Error('terminated'), { cause: tooDeep });
    expect(isRetryableGithubBinaryBufferFailure(tooDeep)).toBe(false);
  });

  test('classifies only proven GitHub rate limits and resolves provider-directed delays', () => {
    expect(resolveGithubRateLimitRetry({ status: 403, message: 'Forbidden', headers: {}, nowMs: 1_000 })).toBeNull();
    expect(resolveGithubRateLimitRetry({
      status: 403,
      message: 'Forbidden',
      headers: { 'x-ratelimit-remaining': '0' },
      nowMs: 1_000,
    })).toBeNull();
    expect(resolveGithubRateLimitRetry({
      status: 403,
      message: 'Forbidden',
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'not-a-number' },
      nowMs: 1_000,
    })).toBeNull();
    expect(resolveGithubRateLimitRetry({
      status: 429,
      message: 'Too Many Requests',
      headers: { 'retry-after': '2' },
      nowMs: 1_000,
    })).toEqual({ delayMs: 2_000 });
    expect(resolveGithubRateLimitRetry({
      status: 403,
      message: 'API rate limit exceeded',
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4' },
      nowMs: 1_000,
    })).toEqual({ delayMs: 3_000 });
    expect(resolveGithubRateLimitRetry({
      status: 403,
      message: 'secondary rate limit',
      headers: {},
      nowMs: 1_000,
    })).toEqual({ delayMs: 60_000 });
  });

  test('preserves the default API version and accepts an explicit version', () => {
    expect(buildHeaders({ token: 'token' })['x-github-api-version']).toBe('2022-11-28');
    expect(buildHeaders({ token: 'token', apiVersion: '2026-03-10' })['x-github-api-version']).toBe('2026-03-10');
  });

  test('requestGithubJson retries retryable 5xx responses and returns parsed JSON', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => JSON.stringify({ message: 'Server Error' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      });
    global.fetch = fetchMock;

    const result = await requestGithubJson({
      token: 'token',
      url: 'https://api.github.com/repos/MasarX/MasarX/actions/runs',
      userAgent: 'jest-test',
      maxAttempts: 2,
      retryDelayMs: 1,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers['x-github-api-version']).toBe('2022-11-28');
  });

  test('request and in-memory download propagate an explicit API version', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) })
      .mockResolvedValueOnce(binaryResponse(['ok']));

    await requestGithubJson({ token: 'token', url: 'https://api.github.com/example', apiVersion: '2026-03-10' });
    const bytes = await downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/example.zip',
      apiVersion: '2026-03-10',
    });

    expect(bytes).toEqual(Buffer.from('ok'));
    expect(global.fetch.mock.calls[0][1].headers['x-github-api-version']).toBe('2026-03-10');
    expect(global.fetch.mock.calls[1][1].headers['x-github-api-version']).toBe('2026-03-10');
  });

  test('optionally aborts a bounded request without changing the default contract', async () => {
    global.fetch = jest.fn((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await expect(requestGithubJson({
      token: 'token',
      url: 'https://api.github.com/slow',
      requestTimeoutMs: 1,
      maxAttempts: 1,
    })).rejects.toThrow('aborted');
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test('does not convert a body-read timeout into an empty successful response', async () => {
    global.fetch = jest.fn(async (url, options) => ({
      ok: true,
      status: 200,
      text: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
      }),
    }));
    await expect(requestGithubJson({
      token: 'token',
      url: 'https://api.github.com/slow-body',
      requestTimeoutMs: 1,
      maxAttempts: 1,
    })).rejects.toThrow('body aborted');
  });

  test('requestGithubJson does not retry non-retryable failures', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ message: 'Not Found' }),
    });

    await expect(
      requestGithubJson({
        token: 'token',
        url: 'https://api.github.com/repos/MasarX/MasarX/missing',
        userAgent: 'jest-test',
        maxAttempts: 3,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow('GitHub API 404');

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('requestGithubJson honors Retry-After and reset headers but never retries ordinary permission denials', async () => {
    let clock = 1_000;
    const sleepFn = jest.fn(async (ms) => { clock += ms; });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(errorResponse(429, 'Too Many Requests', { 'retry-after': '2' }))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) })
      .mockResolvedValueOnce(errorResponse(403, 'API rate limit exceeded', {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '6',
      }))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) })
      .mockResolvedValueOnce(errorResponse(403, 'Resource not accessible by integration', {
        'x-ratelimit-remaining': '0',
      }));

    await expect(requestGithubJson({
      token: 'token',
      url: 'https://api.github.com/rate-limited',
      maxAttempts: 2,
      deadlineAtMs: 10_000,
      nowFn: () => clock,
      sleepFn,
    })).resolves.toEqual({ ok: true });
    expect(sleepFn).toHaveBeenNthCalledWith(1, 2_000);

    await expect(requestGithubJson({
      token: 'token',
      url: 'https://api.github.com/rate-reset',
      maxAttempts: 2,
      deadlineAtMs: 10_000,
      nowFn: () => clock,
      sleepFn,
    })).resolves.toEqual({ ok: true });
    expect(sleepFn).toHaveBeenNthCalledWith(2, 3_000);

    await expect(requestGithubJson({
      token: 'token',
      url: 'https://api.github.com/forbidden',
      maxAttempts: 3,
      deadlineAtMs: 10_000,
      nowFn: () => clock,
      sleepFn,
    })).rejects.toThrow('GitHub API 403');
    expect(global.fetch).toHaveBeenCalledTimes(5);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  test('downloadGithubBinary retries retryable failures and writes target file', async () => {
    const payload = Buffer.from('ok');
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'Service Unavailable',
      })
      .mockResolvedValueOnce(binaryResponse([payload]));

    const filePath = `${__dirname}/../../.tmp/github-api-retry.bin`;
    const result = await downloadGithubBinary({
      token: 'token',
      url: 'https://api.github.com/repos/MasarX/MasarX/actions/artifacts/1/zip',
      targetPath: filePath,
      userAgent: 'jest-test',
      maxAttempts: 2,
      retryDelayMs: 1,
    });

    expect(result).toBe(filePath);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('downloadGithubBinaryBuffer retries transient failures and returns the exact bounded bytes', async () => {
    const payload = Buffer.from([0, 1, 2, 253, 254, 255]);
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers(),
        text: async () => 'Service Unavailable',
      })
      .mockResolvedValueOnce(binaryResponse([payload], { 'content-length': String(payload.length) }));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/repos/MasarX/MasarX/actions/artifacts/1/zip',
      userAgent: 'jest-test',
      maxAttempts: 2,
      retryDelayMs: 1,
      maxBytes: payload.length,
    })).resolves.toEqual(payload);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('downloadGithubBinaryBuffer retries a transient nested reader failure and succeeds', async () => {
    const transient = new Error('terminated');
    transient.cause = new Error('body stream failed');
    transient.cause.cause = Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' });
    const failedReader = {
      read: jest.fn().mockRejectedValue(transient),
      releaseLock: jest.fn(),
    };
    const sleepFn = jest.fn(async () => {});
    global.fetch = jest.fn()
      .mockResolvedValueOnce(readerResponse(failedReader))
      .mockResolvedValueOnce(binaryResponse(['recovered']));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/transient-reader.zip',
      maxAttempts: 2,
      retryDelayMs: 1,
      sleepFn,
    })).resolves.toEqual(Buffer.from('recovered'));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(failedReader.releaseLock).toHaveBeenCalledTimes(1);
  });

  test('downloadGithubBinaryBuffer retries a structured nested Undici connect timeout', async () => {
    const transient = new Error('fetch failed');
    transient.cause = new Error('transport failed');
    transient.cause.cause = Object.assign(new Error('connection deadline'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const sleepFn = jest.fn(async () => {});
    global.fetch = jest.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(binaryResponse(['recovered']));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/connect-timeout.zip',
      maxAttempts: 2,
      retryDelayMs: 1,
      sleepFn,
    })).resolves.toEqual(Buffer.from('recovered'));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  test('downloadGithubBinaryBuffer honors a bounded Retry-After response', async () => {
    let clock = 1_000;
    const sleepFn = jest.fn(async (ms) => { clock += ms; });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(errorResponse(429, 'Too Many Requests', { 'retry-after': '1' }))
      .mockResolvedValueOnce(binaryResponse(['ok']));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/rate-limited-buffer.zip',
      maxAttempts: 2,
      deadlineAtMs: 5_000,
      nowFn: () => clock,
      sleepFn,
    })).resolves.toEqual(Buffer.from('ok'));
    expect(sleepFn).toHaveBeenCalledWith(1_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('downloadGithubBinaryBuffer retries its own bounded attempt timeout', async () => {
    global.fetch = jest.fn()
      .mockImplementationOnce(async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
        }, { once: true });
      }))
      .mockResolvedValueOnce(binaryResponse(['recovered']));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/timed-out-buffer.zip',
      maxAttempts: 2,
      requestTimeoutMs: 20,
      retryDelayMs: 1,
    })).resolves.toEqual(Buffer.from('recovered'));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('downloadGithubBinaryBuffer enforces its attempt deadline when fetch ignores abort', async () => {
    global.fetch = jest.fn(() => new Promise(() => {}));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/nonsettling-fetch.zip',
      maxAttempts: 1,
      requestTimeoutMs: 15,
    })).rejects.toThrow('GitHub API deadline exceeded');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('downloadGithubBinaryBuffer enforces its attempt deadline when an error body ignores abort', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      headers: { get: jest.fn(() => null) },
      text: jest.fn(() => new Promise(() => {})),
    });

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/nonsettling-error-body.zip',
      maxAttempts: 1,
      requestTimeoutMs: 15,
    })).rejects.toThrow('GitHub API deadline exceeded');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('downloadGithubBinaryBuffer rejects an error body that resolves after the live deadline', async () => {
    let clock = 1_000;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      headers: { get: jest.fn(() => null) },
      text: jest.fn(async () => {
        clock = 1_005;
        return 'late error body';
      }),
    });

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/post-error-body-deadline.zip',
      maxAttempts: 1,
      deadlineAtMs: 1_005,
      nowFn: () => clock,
    })).rejects.toThrow('GitHub API deadline exceeded');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('downloadGithubBinaryBuffer stops after bounded transient reader attempts', async () => {
    const transient = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    const reader = {
      read: jest.fn().mockRejectedValue(transient),
      releaseLock: jest.fn(),
    };
    const sleepFn = jest.fn(async () => {});
    global.fetch = jest.fn().mockResolvedValue(readerResponse(reader));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/terminal-reader.zip',
      maxAttempts: 2,
      retryDelayMs: 1,
      sleepFn,
    })).rejects.toBe(transient);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(2);
  });

  test('downloadGithubBinaryBuffer does not retry a non-transient terminated reader failure', async () => {
    const failure = new Error('terminated');
    failure.cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const reader = {
      read: jest.fn().mockRejectedValue(failure),
      releaseLock: jest.fn(),
    };
    const sleepFn = jest.fn();
    global.fetch = jest.fn().mockResolvedValue(readerResponse(reader));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/non-transient-reader.zip',
      maxAttempts: 3,
      retryDelayMs: 1,
      sleepFn,
    })).rejects.toBe(failure);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test('downloadGithubBinaryBuffer preserves an external abort during a reader failure', async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error('AbortError'), { name: 'AbortError' });
    const reader = {
      read: jest.fn(async () => {
        controller.abort();
        throw abortError;
      }),
      releaseLock: jest.fn(),
    };
    const sleepFn = jest.fn();
    global.fetch = jest.fn().mockResolvedValue(readerResponse(reader));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/aborted-reader.zip',
      maxAttempts: 3,
      retryDelayMs: 1,
      sleepFn,
      signal: controller.signal,
    })).rejects.toBe(abortError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test('downloadGithubBinaryBuffer cannot retry a transient reader failure past its deadline', async () => {
    let clock = 1_000;
    const transient = Object.assign(new Error('body socket reset'), { code: 'ECONNRESET' });
    const reader = {
      read: jest.fn(async () => {
        clock = 1_005;
        throw transient;
      }),
      releaseLock: jest.fn(),
    };
    const sleepFn = jest.fn();
    global.fetch = jest.fn().mockResolvedValue(readerResponse(reader));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/deadline-reader.zip',
      maxAttempts: 3,
      retryDelayMs: 1,
      deadlineAtMs: 1_005,
      nowFn: () => clock,
      sleepFn,
    })).rejects.toThrow('GitHub API deadline exceeded');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test('downloadGithubBinaryBuffer rejects a reader that never settles at the hard attempt boundary', async () => {
    jest.useFakeTimers();
    const reader = {
      read: jest.fn(() => new Promise(() => {})),
      cancel: jest.fn(() => new Promise(() => {})),
      releaseLock: jest.fn(),
    };
    global.fetch = jest.fn().mockResolvedValue(readerResponse(reader));

    const rejection = expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/nonsettling-reader.zip',
      maxAttempts: 1,
      requestTimeoutMs: 15,
    })).rejects.toThrow('GitHub API deadline exceeded');
    await jest.advanceTimersByTimeAsync(0);
    expect(reader.read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(15);
    await rejection;
    await jest.runAllTimersAsync();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  test('downloadGithubBinaryBuffer cannot accept a read that resolves after its hard boundary', async () => {
    jest.useFakeTimers();
    const reader = {
      read: jest.fn(() => new Promise((resolve) => {
        setTimeout(() => resolve({ done: false, value: Buffer.from('late') }), 40);
      })),
      cancel: jest.fn(),
      releaseLock: jest.fn(),
    };
    global.fetch = jest.fn().mockResolvedValue(readerResponse(reader));

    const rejection = expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/late-reader.zip',
      maxAttempts: 1,
      requestTimeoutMs: 10,
    })).rejects.toThrow('GitHub API deadline exceeded');
    await jest.advanceTimersByTimeAsync(0);
    expect(reader.read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10);
    await rejection;
    await jest.runAllTimersAsync();
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  test('downloadGithubBinaryBuffer applies a live deadline check after every resolved read', async () => {
    let clock = 1_000;
    const reader = {
      read: jest.fn(async () => {
        clock = 1_005;
        return { done: false, value: Buffer.from('too-late') };
      }),
      cancel: jest.fn(),
      releaseLock: jest.fn(),
    };
    global.fetch = jest.fn().mockResolvedValue(readerResponse(reader));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/post-read-deadline.zip',
      maxAttempts: 1,
      deadlineAtMs: 1_005,
      nowFn: () => clock,
    })).rejects.toThrow('GitHub API deadline exceeded');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledTimes(1);
  });

  test('downloadGithubBinaryBuffer enforces the declared size and an exhausted wall-clock deadline', async () => {
    global.fetch = jest.fn().mockResolvedValue(binaryResponse(['12345678'], { 'content-length': '8' }));
    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/too-large.zip',
      maxBytes: 7,
      maxAttempts: 1,
    })).rejects.toThrow('GitHub binary exceeds byte limit: 7');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    global.fetch = jest.fn().mockResolvedValue(binaryResponse(['not-read']));
    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/deadline.zip',
      deadlineAtMs: 1_000,
      nowFn: () => 1_000,
    })).rejects.toThrow('GitHub API deadline exceeded');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('downloadGithubBinaryBuffer does not await byte-limit reader cancellation', async () => {
    const reader = {
      read: jest.fn().mockResolvedValue({ done: false, value: Buffer.from('12345678') }),
      cancel: jest.fn(() => new Promise(() => {})),
      releaseLock: jest.fn(),
    };
    global.fetch = jest.fn().mockResolvedValue(readerResponse(reader));

    await expect(downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/byte-limit-cancel.zip',
      maxBytes: 7,
      maxAttempts: 1,
      requestTimeoutMs: 100,
    })).rejects.toThrow('GitHub binary exceeds byte limit: 7');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  test('downloadGithubBinary honors a bounded rate-limit Retry-After before streaming', async () => {
    let clock = 1_000;
    const sleepFn = jest.fn(async (ms) => { clock += ms; });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(errorResponse(429, 'Too Many Requests', { 'retry-after': '1' }))
      .mockResolvedValueOnce(binaryResponse(['ok']));
    const filePath = `${__dirname}/../../.tmp/github-api-retry-rate-limited.bin`;

    await expect(downloadGithubBinary({
      token: 'token',
      url: 'https://api.github.com/rate-limited.zip',
      targetPath: filePath,
      maxAttempts: 2,
      deadlineAtMs: 5_000,
      nowFn: () => clock,
      sleepFn,
    })).resolves.toBe(filePath);
    expect(sleepFn).toHaveBeenCalledWith(1_000);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('ok');
  });

  test('downloadGithubBinary does not retry a permission denial with a malformed reset header', async () => {
    const sleepFn = jest.fn();
    global.fetch = jest.fn().mockResolvedValue(errorResponse(403, 'Resource not accessible by integration', {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': 'not-a-number',
    }));

    await expect(downloadGithubBinary({
      token: 'token',
      url: 'https://api.github.com/forbidden.zip',
      targetPath: `${__dirname}/../../.tmp/github-api-retry-forbidden.bin`,
      maxAttempts: 3,
      deadlineAtMs: 5_000,
      nowFn: () => 1_000,
      sleepFn,
    })).rejects.toThrow('GitHub API 403');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test('rate-limit waits cannot escape the remaining deadline', async () => {
    const sleepFn = jest.fn();
    global.fetch = jest.fn().mockResolvedValue(
      errorResponse(429, 'Too Many Requests', { 'retry-after': '10' }),
    );
    await expect(requestGithubJson({
      token: 'token',
      url: 'https://api.github.com/rate-limited',
      maxAttempts: 2,
      deadlineAtMs: 5_000,
      nowFn: () => 1_000,
      sleepFn,
    })).rejects.toThrow('GitHub API deadline exceeded');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test('streams downloads and removes the partial file when the hard byte limit is exceeded', async () => {
    global.fetch = jest.fn().mockResolvedValue(binaryResponse(['1234', '5678']));
    const filePath = `${__dirname}/../../.tmp/github-api-retry-too-large.bin`;
    await expect(downloadGithubBinary({
      token: 'token',
      url: 'https://api.github.com/large.zip',
      targetPath: filePath,
      maxBytes: 7,
      maxAttempts: 1,
    })).rejects.toThrow('GitHub binary exceeds byte limit: 7');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('bounds retry attempts and binary reads by the remaining wall-clock deadline', async () => {
    let clock = 1000;
    const sleepFn = jest.fn(async (ms) => { clock += ms; });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
      text: async () => 'Unavailable',
    });
    await expect(requestGithubJson({
      token: 'token',
      url: 'https://api.github.com/retry',
      maxAttempts: 4,
      retryDelayMs: 5,
      deadlineAtMs: 1005,
      nowFn: () => clock,
      sleepFn,
    })).rejects.toThrow('GitHub API deadline exceeded');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();

    global.fetch = jest.fn().mockResolvedValue(binaryResponse(['ok']));
    await expect(downloadGithubBinary({
      token: 'token',
      url: 'https://api.github.com/deadline.zip',
      targetPath: `${__dirname}/../../.tmp/deadline.bin`,
      deadlineAtMs: clock,
      nowFn: () => clock,
    })).rejects.toThrow('GitHub API deadline exceeded');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['json request', (signal) => requestGithubJson({
      token: 'token',
      url: 'https://api.github.com/abort-json',
      maxAttempts: 4,
      signal,
    })],
    ['binary download', (signal) => downloadGithubBinary({
      token: 'token',
      url: 'https://api.github.com/abort-binary',
      targetPath: `${__dirname}/../../.tmp/abort-binary.bin`,
      maxAttempts: 4,
      signal,
    })],
    ['in-memory binary download', (signal) => downloadGithubBinaryBuffer({
      token: 'token',
      url: 'https://api.github.com/abort-binary-buffer',
      maxAttempts: 4,
      signal,
    })],
  ])('propagates an external abort through the in-flight %s without retry', async (_label, invoke) => {
    const controller = new AbortController();
    global.fetch = jest.fn(async (_url, options) => new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error('AbortError');
        error.name = 'AbortError';
        reject(error);
      };
      if (options.signal.aborted) rejectAbort();
      else options.signal.addEventListener('abort', rejectAbort, { once: true });
    }));
    const operation = invoke(controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(operation).rejects.toThrow(/AbortError|aborted/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
