const {
  RETRYABLE_STATUS_CODES,
  isRetryableGithubApiFailure,
  requestGithubJson,
  downloadGithubBinary,
} = require('../../../scripts/ops/ci/github-api-retry');

describe('github-api-retry', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GITHUB_API_MAX_ATTEMPTS;
    delete process.env.GITHUB_API_RETRY_DELAY_MS;
  });

  test('classifies retryable GitHub API failures', () => {
    expect(RETRYABLE_STATUS_CODES.has(502)).toBe(true);
    expect(isRetryableGithubApiFailure({ status: 502, message: 'Server Error' })).toBe(true);
    expect(isRetryableGithubApiFailure({ status: 404, message: 'Not Found' })).toBe(false);
    expect(isRetryableGithubApiFailure({ message: 'fetch failed: socket hang up' })).toBe(true);
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

  test('downloadGithubBinary retries retryable failures and writes target file', async () => {
    const payload = Buffer.from('ok');
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'Service Unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => payload,
      });

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
});
