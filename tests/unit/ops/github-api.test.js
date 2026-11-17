const {
  RETRYABLE_STATUS_CODES,
  resolveRetryConfig,
  computeBackoffDelayMs,
  githubRequestJson,
  githubPaginate,
} = require('../../../scripts/ops/ci/github-api');

function createResponse({ ok, status, statusText = '', jsonBody, textBody = '', headers = {} }) {
  return {
    ok,
    status,
    statusText,
    json: jest.fn().mockResolvedValue(jsonBody),
    text: jest.fn().mockResolvedValue(textBody),
    headers: {
      get(name) {
        const key = String(name || '').toLowerCase();
        return Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] : null;
      },
    },
  };
}

describe('github-api helper', () => {
  test('declares the expected retryable status codes', () => {
    expect(Array.from(RETRYABLE_STATUS_CODES).sort((a, b) => a - b)).toEqual([408, 429, 500, 502, 503, 504]);
  });

  test('resolveRetryConfig honors env overrides and delay alias', () => {
    expect(resolveRetryConfig({
      GITHUB_API_RETRY_ATTEMPTS: '5',
      GITHUB_API_RETRY_DELAY_MS: '250',
      GITHUB_API_RETRY_MAX_DELAY_MS: '2000',
    })).toEqual({
      maxAttempts: 5,
      baseDelayMs: 250,
      maxDelayMs: 2000,
    });
  });

  test('computeBackoffDelayMs honors Retry-After and caps at max delay', () => {
    expect(computeBackoffDelayMs({
      attempt: 2,
      retryAfter: '9',
      baseDelayMs: 500,
      maxDelayMs: 2500,
    })).toBe(2500);
    expect(computeBackoffDelayMs({
      attempt: 3,
      baseDelayMs: 400,
      maxDelayMs: 5000,
    })).toBe(1600);
  });

  test('retries a 504 response and then succeeds', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(createResponse({
        ok: false,
        status: 504,
        statusText: 'Gateway Timeout',
        textBody: 'timeout',
        headers: { 'retry-after': '1' },
      }))
      .mockResolvedValueOnce(createResponse({
        ok: true,
        status: 200,
        jsonBody: { ok: true },
      }));
    const sleepImpl = jest.fn().mockResolvedValue();
    const consoleImpl = { warn: jest.fn() };

    await expect(githubRequestJson({
      token: 'token',
      url: 'https://api.github.com/repos/MasarX/MasarX/pulls/1',
      userAgent: 'test-agent',
      retryConfig: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000 },
      fetchImpl,
      sleepImpl,
      consoleImpl,
    })).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(1000);
    expect(consoleImpl.warn).toHaveBeenCalledWith(expect.stringContaining('GitHub API 504'));
  });

  test('retries transport failures until max attempts are exhausted', async () => {
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('socket hang up'))
      .mockRejectedValueOnce(new TypeError('connection reset'));
    const sleepImpl = jest.fn().mockResolvedValue();
    const consoleImpl = { warn: jest.fn() };

    await expect(githubRequestJson({
      token: 'token',
      url: 'https://api.github.com/repos/MasarX/MasarX/issues/1',
      retryConfig: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
      fetchImpl,
      sleepImpl,
      consoleImpl,
    })).rejects.toThrow('GitHub API request failed');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 50);
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 100);
    expect(consoleImpl.warn).toHaveBeenCalledTimes(2);
  });

  test('does not retry non-retryable responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createResponse({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      textBody: 'missing',
    }));

    await expect(githubRequestJson({
      token: 'token',
      url: 'https://api.github.com/repos/MasarX/MasarX/issues/404',
      fetchImpl,
      sleepImpl: jest.fn().mockResolvedValue(),
      consoleImpl: { warn: jest.fn() },
    })).rejects.toThrow('GitHub API 404');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('githubPaginate requests pages until a short page is returned', async () => {
    const requestImpl = jest.fn()
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })))
      .mockResolvedValueOnce([{ id: 101 }, { id: 102 }]);

    await expect(githubPaginate({
      token: 'token',
      url: 'https://api.github.com/repos/MasarX/MasarX/pulls/1/files',
      userAgent: 'test-agent',
      requestImpl,
    })).resolves.toEqual([
      ...Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
      { id: 101 },
      { id: 102 },
    ]);

    expect(requestImpl).toHaveBeenNthCalledWith(1, expect.objectContaining({
      token: 'token',
      url: 'https://api.github.com/repos/MasarX/MasarX/pulls/1/files?per_page=100&page=1',
      userAgent: 'test-agent',
    }));
    expect(requestImpl).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: 'https://api.github.com/repos/MasarX/MasarX/pulls/1/files?per_page=100&page=2',
    }));
  });
});
