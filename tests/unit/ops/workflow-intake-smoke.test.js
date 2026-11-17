const {
  resolveDatabaseUrl,
  resolveRetryConfig,
  runWorkflowIntakeSmokeWithRetry,
} = require('../../../scripts/ops/gates/workflow-intake-smoke');

describe('workflow-intake-smoke', () => {
  test('prefers pinned PG_CONN_STRING over DATABASE_URL', () => {
    expect(resolveDatabaseUrl({
      PG_CONN_STRING: 'postgres://pinned.example/db',
      DATABASE_URL: 'postgres://raw.example/db',
    })).toBe('postgres://pinned.example/db');
  });

  test('falls back to DATABASE_URL when no pinned connection exists', () => {
    expect(resolveDatabaseUrl({
      DATABASE_URL: 'postgres://raw.example/db',
    })).toBe('postgres://raw.example/db');
  });

  test('inherits bounded retry defaults from the shared DB smoke contract', () => {
    expect(resolveRetryConfig({})).toEqual({
      maxWaitMs: 120000,
      retryDelayMs: 2000,
    });
    expect(
      resolveRetryConfig({
        WORKFLOW_INTAKE_SMOKE_DB_MAX_WAIT_MS: '1500',
        WORKFLOW_INTAKE_SMOKE_DB_RETRY_DELAY_MS: '125',
      }),
    ).toEqual({
      maxWaitMs: 1500,
      retryDelayMs: 125,
    });
  });

  test('retries transient preview DB auth lag before succeeding', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const logger = { log: jest.fn(), warn: jest.fn() };
    const clients = [
      {
        connect: jest.fn().mockRejectedValueOnce(new Error('Tenant or user not found')),
        query: jest.fn(),
        end: jest.fn().mockResolvedValue(undefined),
      },
      {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(async (sql) => {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
          if (/SELECT workflow_intake_webhook/.test(sql)) {
            return { rows: [{ ack: { status: 202, response_mode: 'async' } }] };
          }
          return { rows: [] };
        }),
        end: jest.fn().mockResolvedValue(undefined),
      },
    ];
    const clientFactory = jest.fn(() => clients.shift());

    const result = await runWorkflowIntakeSmokeWithRetry({
      env: {
        PG_CONN_STRING: 'postgres://pooler.example/postgres',
        WORKFLOW_INTAKE_SMOKE_DB_MAX_WAIT_MS: '250',
        WORKFLOW_INTAKE_SMOKE_DB_RETRY_DELAY_MS: '1',
      },
      clientFactory,
      uuidFactory: () => '00000000-0000-4000-8000-000000000000',
      logger,
      sleepFn,
    });

    expect(result.attempts).toBe(2);
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('transient DB readiness delay'),
    );
  });

  test('fails closed after exhausting the retry window for transient DB auth lag', async () => {
    const clientFactory = jest.fn(() => ({
      connect: jest.fn().mockRejectedValue(new Error('Tenant or user not found')),
      query: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined),
    }));

    await expect(
      runWorkflowIntakeSmokeWithRetry({
        env: {
          PG_CONN_STRING: 'postgres://pooler.example/postgres',
          WORKFLOW_INTAKE_SMOKE_DB_MAX_WAIT_MS: '1',
          WORKFLOW_INTAKE_SMOKE_DB_RETRY_DELAY_MS: '1',
        },
        clientFactory,
        sleepFn: jest.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('workflow intake smoke did not become ready within retry window');
  });
});
