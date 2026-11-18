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
    const resolveDatabaseUrlWithFallbackFn = jest.fn(async () => ({
      dsn: 'postgres://pooler.example/postgres',
      candidateName: 'DATABASE_URL_POOLER+poolerhost:aws-0',
    }));

    const result = await runWorkflowIntakeSmokeWithRetry({
      env: {
        DATABASE_URL: 'postgres://stale.example/postgres',
        WORKFLOW_INTAKE_SMOKE_DB_MAX_WAIT_MS: '250',
        WORKFLOW_INTAKE_SMOKE_DB_RETRY_DELAY_MS: '1',
      },
      resolveDatabaseUrlWithFallbackFn,
      clientFactory,
      uuidFactory: () => '00000000-0000-4000-8000-000000000000',
      logger,
      sleepFn,
    });

    expect(result).toEqual({
      attempts: 2,
      candidateName: 'DATABASE_URL_POOLER+poolerhost:aws-0',
    });
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(resolveDatabaseUrlWithFallbackFn).toHaveBeenCalledTimes(1);
    expect(resolveDatabaseUrlWithFallbackFn).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        DB_SMOKE_SYNC_DB_PASSWORD: '0',
        DB_SMOKE_SYNC_ON_TENANT_NOT_FOUND: '0',
      }),
      maxWaitMs: 250,
      retryDelayMs: 1,
    }));
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('transient DB readiness delay'),
    );
  });

  test('passes an unlabelled PG_CONN_STRING through the shared fallback resolver', async () => {
    const pinnedDsn = 'postgres://pinned.example/postgres';
    const resolver = jest.fn(async ({ env }) => ({
      dsn: env.PG_CONN_STRING,
      candidateName: 'PG_CONN_STRING',
    }));
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        return { rows: [{ ack: { status: 202, response_mode: 'async' } }] };
      }),
      end: jest.fn().mockResolvedValue(undefined),
    };

    await expect(runWorkflowIntakeSmokeWithRetry({
      env: {
        PG_CONN_STRING: pinnedDsn,
        DATABASE_URL: 'postgres://raw.example/postgres',
      },
      resolveDatabaseUrlWithFallbackFn: resolver,
      clientFactory: () => client,
      uuidFactory: () => '00000000-0000-4000-8000-000000000000',
      logger: { log: jest.fn(), warn: jest.fn() },
    })).resolves.toEqual({ attempts: 1, candidateName: 'PG_CONN_STRING' });

    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ PG_CONN_STRING: pinnedDsn }),
    }));
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
        resolveDatabaseUrlWithFallbackFn: jest.fn(async () => ({
          dsn: 'postgres://pooler.example/postgres',
          candidateName: 'PG_CONN_STRING',
        })),
        sleepFn: jest.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('workflow intake smoke did not become ready within retry window');
  });
});
