const {
  getInvokeErrorBodyText,
  getInvokeErrorStatus,
  invokeFunctionWithRetry,
  isRetryableHttpStatus,
  isRetryableInvokeError,
} = require('../../integration/helpers/http');

describe('integration http helpers', () => {
  test('treats transient edge worker status codes as retryable', () => {
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(546)).toBe(true);
    expect(isRetryableHttpStatus(400)).toBe(false);
  });

  test('parses invoke error status and body text from supabase context', () => {
    const err = {
      status: 500,
      context: {
        status: 546,
        body: { code: 'WORKER_LIMIT', message: 'Worker failed to respond due to a resource limit' },
      },
    };

    expect(getInvokeErrorStatus(err)).toBe(546);
    expect(getInvokeErrorBodyText(err)).toContain('WORKER_LIMIT');
    expect(isRetryableInvokeError(err)).toBe(true);
  });

  test('retries invoke failures until the function succeeds', async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: {
          message: 'Edge Functions Error',
          context: { status: 502, body: { message: 'An invalid response was received from the upstream server' } },
        },
      })
      .mockResolvedValueOnce({
        data: { ok: true },
        error: null,
      });

    const client = { functions: { invoke } };
    const result = await invokeFunctionWithRetry(
      client,
      'label-renderer',
      { body: { mode: 'designer_preview' } },
      { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, purpose: 'unit retry' },
    );

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ data: { ok: true }, error: null });
  });
});
