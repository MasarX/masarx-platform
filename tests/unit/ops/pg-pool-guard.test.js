const {
  connectWithTransientRetry,
  isTransientDbTerminationMessage,
  isTransientDbTerminationError,
  isPreviewAuthLagMessage,
  isRetryablePoolConnectError,
  getPoolConnectRetryAttempts,
  getPoolConnectRetryDelayMs,
  shouldRetryPreviewAuthLag,
} = require('../../../scripts/utils/pg-pool-guard');

describe('pg-pool-guard transient detection', () => {
  test.each([
    'DbHandler exited. Check logs for more information.',
    'terminating connection due to administrator command',
    'the database system is shutting down',
    'connection terminated unexpectedly',
    'server closed the connection unexpectedly',
    '{:shutdown, :db_termination}',
  ])('accepts transient shutdown message: %s', (message) => {
    expect(isTransientDbTerminationMessage(message)).toBe(true);
  });

  test('rejects unrelated messages', () => {
    expect(isTransientDbTerminationMessage('permission denied for schema public')).toBe(false);
  });

  test.each([
    'Tenant or user not found',
    'password authentication failed for user "postgres"',
    'too many authentication errors',
  ])('accepts preview auth lag message: %s', (message) => {
    expect(isPreviewAuthLagMessage(message)).toBe(true);
  });

  test('accepts known transient error codes with transient message', () => {
    expect(
      isTransientDbTerminationError({
        code: 'XX000',
        message: 'DbHandler exited. Check logs for more information.',
      }),
    ).toBe(true);

    expect(
      isTransientDbTerminationError({
        code: '57P01',
        message: 'terminating connection due to administrator command',
      }),
    ).toBe(true);
  });

  test('accepts missing error code when message is transient', () => {
    expect(
      isTransientDbTerminationError({
        message: 'the database system is shutting down',
      }),
    ).toBe(true);
  });

  test('rejects non-transient error codes', () => {
    expect(
      isTransientDbTerminationError({
        code: '42501',
        message: 'DbHandler exited. Check logs for more information.',
      }),
    ).toBe(false);
  });

  test('enables preview auth lag retry only for opted-in preview/CI contexts', () => {
    expect(
      shouldRetryPreviewAuthLag({
        CI: '1',
        PREVIEW_SUPABASE_URL: 'https://preview.example',
      }),
    ).toBe(true);
    expect(
      shouldRetryPreviewAuthLag({
        CI: '1',
      }),
    ).toBe(false);
    expect(
      shouldRetryPreviewAuthLag({
        PG_POOL_CONNECT_RETRY_AUTH_LAG: '1',
      }),
    ).toBe(true);
  });

  test('treats preview auth lag as retryable only when enabled', () => {
    const error = new Error('Tenant or user not found');
    expect(isRetryablePoolConnectError(error, { CI: '1', PREVIEW_PROJECT_REF: 'abc123' })).toBe(true);
    expect(isRetryablePoolConnectError(error, {})).toBe(false);
  });
});

describe('pg-pool-guard transient connect retry', () => {
  test('retries transient pool.connect failures and returns the later success', async () => {
    const result = { ok: true };
    const connectFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce(result);
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const logger = jest.fn();

    await expect(
      connectWithTransientRetry(connectFn, {
        attempts: 3,
        delayMs: 25,
        sleepFn,
        logger,
      }),
    ).resolves.toBe(result);

    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(25);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Retrying transient pool.connect failure (1/2)'),
    );
  });

  test('retries preview auth lag failures when the preview retry contract is enabled', async () => {
    const result = { ok: true };
    const connectFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Tenant or user not found'))
      .mockResolvedValueOnce(result);
    const sleepFn = jest.fn().mockResolvedValue(undefined);

    await expect(
      connectWithTransientRetry(connectFn, {
        attempts: 4,
        delayMs: 10,
        sleepFn,
        env: {
          CI: '1',
          PREVIEW_SUPABASE_URL: 'https://preview.example',
        },
      }),
    ).resolves.toBe(result);

    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  test('does not retry non-transient pool.connect failures', async () => {
    const connectFn = jest.fn().mockRejectedValue(new Error('permission denied for schema public'));
    const sleepFn = jest.fn();

    await expect(
      connectWithTransientRetry(connectFn, {
        attempts: 3,
        delayMs: 25,
        sleepFn,
      }),
    ).rejects.toThrow('permission denied for schema public');

    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test('throws after exhausting transient retry attempts', async () => {
    const connectFn = jest
      .fn()
      .mockRejectedValue(new Error('server closed the connection unexpectedly'));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const logger = jest.fn();

    await expect(
      connectWithTransientRetry(connectFn, {
        attempts: 2,
        delayMs: 40,
        sleepFn,
        logger,
      }),
    ).rejects.toThrow('server closed the connection unexpectedly');

    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(40);
  });

  test('parses retry env knobs with sane defaults', () => {
    const originalAttempts = process.env.PG_POOL_CONNECT_RETRY_ATTEMPTS;
    const originalDelayMs = process.env.PG_POOL_CONNECT_RETRY_DELAY_MS;

    process.env.PG_POOL_CONNECT_RETRY_ATTEMPTS = '4';
    process.env.PG_POOL_CONNECT_RETRY_DELAY_MS = '175';
    expect(getPoolConnectRetryAttempts()).toBe(4);
    expect(getPoolConnectRetryDelayMs()).toBe(175);

    process.env.PG_POOL_CONNECT_RETRY_ATTEMPTS = '0';
    process.env.PG_POOL_CONNECT_RETRY_DELAY_MS = '-1';
    expect(getPoolConnectRetryAttempts()).toBe(3);
    expect(getPoolConnectRetryDelayMs()).toBe(250);

    if (typeof originalAttempts === 'undefined') delete process.env.PG_POOL_CONNECT_RETRY_ATTEMPTS;
    else process.env.PG_POOL_CONNECT_RETRY_ATTEMPTS = originalAttempts;
    if (typeof originalDelayMs === 'undefined') delete process.env.PG_POOL_CONNECT_RETRY_DELAY_MS;
    else process.env.PG_POOL_CONNECT_RETRY_DELAY_MS = originalDelayMs;
  });
});
