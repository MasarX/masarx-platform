const {
  DEFAULT_TABULAR_IMPORT_WORKER_ONCE_MAX_RUNTIME_MS,
  DEFAULT_TABULAR_IMPORT_WORKER_RPC_TIMEOUT_MS,
  buildWorkerRuntimeConfig,
  claimExplicitRun,
  createRuntimeGuard,
  resolveRunClaim,
} = require('../../scripts/workers/tabular-import-worker.js');

describe('tabular-import-worker runtime guards', () => {
  test('buildWorkerRuntimeConfig keeps bounded once defaults', () => {
    const config = buildWorkerRuntimeConfig(['--once'], {
      TABULAR_IMPORT_WORKER_ID: 'worker-default',
    });

    expect(config).toEqual({
      once: true,
      runId: null,
      workerId: 'worker-default',
      pollMs: 3000,
      batchSize: null,
      onceMaxRuntimeMs: DEFAULT_TABULAR_IMPORT_WORKER_ONCE_MAX_RUNTIME_MS,
      rpcTimeoutMs: DEFAULT_TABULAR_IMPORT_WORKER_RPC_TIMEOUT_MS,
    });
  });

  test('buildWorkerRuntimeConfig accepts explicit runtime overrides', () => {
    const config = buildWorkerRuntimeConfig(
      [
        '--once',
        '--worker-id',
        'worker-custom',
        '--poll-ms',
        '1500',
        '--batch-size',
        '25',
        '--max-runtime-ms',
        '45000',
        '--rpc-timeout-ms',
        '12000',
      ],
      {},
    );

    expect(config).toEqual({
      once: true,
      runId: null,
      workerId: 'worker-custom',
      pollMs: 1500,
      batchSize: 25,
      onceMaxRuntimeMs: 45000,
      rpcTimeoutMs: 12000,
    });
  });

  test('buildWorkerRuntimeConfig accepts an explicit run id for deterministic once execution', () => {
    const config = buildWorkerRuntimeConfig(
      [
        '--once',
        '--run-id',
        '0d18faaf-1dec-4666-9a50-859dbb043014',
      ],
      {},
    );

    expect(config.runId).toBe('0d18faaf-1dec-4666-9a50-859dbb043014');
    expect(config.once).toBe(true);
  });

  test('createRuntimeGuard returns quick results while budget remains', async () => {
    const guard = createRuntimeGuard({ enabled: true, maxRuntimeMs: 100 });

    await expect(
      guard.withTimeout(async () => 'ok', 'quick operation', 25),
    ).resolves.toBe('ok');
  });

  test('createRuntimeGuard rejects stalled operations with a bounded timeout error', async () => {
    const guard = createRuntimeGuard({ enabled: true, maxRuntimeMs: 100 });

    await expect(
      guard.withTimeout(() => new Promise(() => {}), 'stalled operation', 20),
    ).rejects.toThrow('stalled operation timed out after 20ms');
  });

  test('claimExplicitRun deterministically claims one queued run without the generic queue rpc', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            task_id: '195724fc-af55-4e74-9b14-f94d0134e7ae',
            organization_id: 'c9298f7e-5d2d-4aa8-8cdd-2fa415ee0e0d',
            run_id: '0d18faaf-1dec-4666-9a50-859dbb043014',
            queue_key: 'tabular-import:demo',
            resource_key: 'shipments',
            write_mode: 'create',
            summary: { headers: ['Tracking Number'] },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      claimExplicitRun({
        runId: '0d18faaf-1dec-4666-9a50-859dbb043014',
        query,
        workerId: 'worker-explicit',
      }),
    ).resolves.toEqual({
      organization_id: 'c9298f7e-5d2d-4aa8-8cdd-2fa415ee0e0d',
      queue_key: 'tabular-import:demo',
      resource_key: 'shipments',
      run_id: '0d18faaf-1dec-4666-9a50-859dbb043014',
      task_id: '195724fc-af55-4e74-9b14-f94d0134e7ae',
      summary: { headers: ['Tracking Number'] },
      worker_id: 'worker-explicit',
      write_mode: 'create',
    });
    expect(query).toHaveBeenNthCalledWith(
      1,
      'begin',
      [],
      'begin explicit tabular import run claim',
    );
    expect(query).toHaveBeenNthCalledWith(
      5,
      'commit',
      [],
      'commit explicit tabular import run claim',
    );
  });

  test('resolveRunClaim keeps the explicit path on the deterministic query claim', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            task_id: '195724fc-af55-4e74-9b14-f94d0134e7ae',
            organization_id: 'c9298f7e-5d2d-4aa8-8cdd-2fa415ee0e0d',
            run_id: '0d18faaf-1dec-4666-9a50-859dbb043014',
            queue_key: 'tabular-import:demo',
            resource_key: 'shipments',
            write_mode: 'create',
            summary: { headers: ['Tracking Number'] },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const rpc = jest.fn();

    await expect(
      resolveRunClaim({
        explicitRunId: '0d18faaf-1dec-4666-9a50-859dbb043014',
        query,
        rpc,
        workerId: 'worker-explicit',
      }),
    ).resolves.toMatchObject({
      run_id: '0d18faaf-1dec-4666-9a50-859dbb043014',
      task_id: '195724fc-af55-4e74-9b14-f94d0134e7ae',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('claimExplicitRun fails clearly when the selected run is not claimable', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            run_id: '0d18faaf-1dec-4666-9a50-859dbb043014',
            run_status: 'processing',
            task_status: 'in_progress',
          },
        ],
      });

    await expect(
      claimExplicitRun({
        runId: '0d18faaf-1dec-4666-9a50-859dbb043014',
        query,
        workerId: 'worker-explicit',
      }),
    ).rejects.toThrow(
      'tabular import worker run 0d18faaf-1dec-4666-9a50-859dbb043014 is not claimable (run_status=processing, task_status=in_progress)',
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'rollback',
      [],
      'rollback explicit tabular import run claim',
    );
  });
});
